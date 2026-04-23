"""Watchdog finding model: shapes, defaults, fingerprinting, grouping.

This module owns the *data shape* of a watchdog finding and everything
needed to construct, normalize, and aggregate one. It is deliberately
free of I/O and of any detector logic so that both the rule-based
detectors ([file](backend/services/watchdog/rules.py)) and the AI
hypothesis layer ([file](backend/services/watchdog/ai.py)) can depend
on it without pulling in the rest of the package.

What this module owns
---------------------
- The in-memory schema of a "finding" (one observation of a potential
  problem made by some detector — e.g. "LLM error rate too high").
- The *fingerprint* function that collapses many repeat observations of
  the same symptom down to a single stable key so the UI can show
  "this incident happened 12 times" instead of 12 separate rows.
- The per-category default copy (owner team, runbook hint, impact copy,
  likely cause, investigation steps, debug commands) so every detector
  produces richly-filled-in cards without duplicating boilerplate.
- The grouping helper that turns a stream of individual findings into
  the list of incidents the operator actually sees.

What this module does NOT own
-----------------------------
- No rule logic (who decides when a finding should fire) — that lives
  in [file](backend/services/watchdog/rules.py).
- No AI / LLM calls — the AI hypothesis layer lives in
  [file](backend/services/watchdog/ai.py).
- No I/O, disk, or HTTP — the JSONL writer / reader and the HTTP routes
  live in [file](backend/services/watchdog/__init__.py) and
  [file](backend/api/routers/watchdog.py).

Who calls this module
---------------------
``rules.py``, ``ai.py``, and the watchdog API router all build
``WatchdogFinding`` values via :func:`make_finding` and normalize them
via :func:`normalize_finding_payload` before emitting them.

Python primer (what some of the Python-specific things below do)
----------------------------------------------------------------
- ``@dataclass``: a decorator that tells Python "this class is mostly a
  bag of named fields" — Python then auto-generates ``__init__``,
  ``__repr__``, and ``__eq__`` methods from the annotated fields. Saves
  writing a constructor by hand.
- ``field(default_factory=list)``: dataclass fields with a mutable
  default (list / dict) cannot use a plain ``= []`` default because
  then every instance would share the *same* list. ``default_factory``
  takes a zero-arg callable and calls it once per new instance, so each
  instance gets its own fresh list.
- ``@dataclass(frozen=True)``: not used here, but its siblings in the
  codebase use it — means the instance is immutable after construction.
- ``*`` in a function signature (e.g. ``def f(*, a, b)``): everything
  after the ``*`` must be passed by keyword, never positionally. Used
  on :func:`make_finding` so callers write
  ``make_finding(severity=..., category=...)`` instead of being able
  to mix up positional arguments.
- ``str | None``: Python 3.10+ type-union syntax. Means "either a
  string or the ``None`` sentinel". ``from __future__ import
  annotations`` makes these hints lazy strings so they cost nothing at
  runtime.
- ``dict[str, Any]``: a dict whose keys are strings and whose values
  are "anything". Just a type hint for documentation — Python does not
  enforce it at runtime.

Public surface (also re-exported from ``backend.services.watchdog``):

- :class:`WatchdogFinding`        — canonical dataclass.
- :func:`make_finding`            — keyword-only builder with category defaults.
- :func:`normalize_finding_payload` — coerce a dict into the canonical shape.
- :func:`group_findings`          — collapse raw findings into incidents.
- Helpers: :func:`severity_rank`, :func:`priority_score`,
  :func:`evidence`, :func:`top_bucket`, :func:`parse_ts`,
  :func:`fingerprint_for`, :func:`defaults_for`.

UI connection
-------------
Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
       and the Watchdog drawer ([file](frontend/src/features/watchdog/components/WatchdogDrawer.tsx)).
UI element: Each IncidentCard on MonitoringPage (title, severity,
evidence rows, "debug commands" copy-buttons, "runbook" link) is a
direct rendering of a WatchdogFinding produced via this module's
helpers. The red/yellow/blue severity chips on the WatchdogBadge in
the TopBar also read fields (``severity``, ``category``, ``count``)
defined here.
Backend route(s): GET /api/watchdog, GET /api/watchdog/recent — see
[file](backend/api/routers/watchdog.py).
Data flow: detector emits finding -> :func:`make_finding` fills
defaults -> :func:`normalize_finding_payload` coerces shape -> JSONL
writer persists -> :func:`group_findings` collapses repeats into
incidents -> API router returns to MonitoringPage / Watchdog drawer.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

# ----- shared constants -----

# Numeric ordering for severity. Used to pick the worst severity when
# multiple observations are grouped into one incident, and to sort the
# "top incidents" list in ``api.stats()``. Unknown severities rank 0.
_SEVERITY_ORDER = {"error": 3, "warning": 2, "info": 1}

# Owner team per category — drives the "Owner" chip on each incident card.
_OWNER_BY_CATEGORY = {
    "perception": "Edge camera ops",
    "drift": "ML quality",
    "llm": "AI platform",
    "stream": "Video ingest",
    "scene": "Scene understanding",
    "system": "Platform",
    "validator": "ML quality",
}

# One-liner runbook hint per category, shown under "Runbook" on the card.
_RUNBOOK_BY_CATEGORY = {
    "perception": "Verify live camera quality, lens obstruction, lighting, and mount stability.",
    "drift": "Review recent false positives, validate labeling coverage, and plan threshold or model updates.",
    "llm": "Inspect provider health, rate limiting, fallback behavior, and token instrumentation.",
    "stream": "Check stream source health, frame throughput, and local resource pressure.",
    "scene": "Validate scene classifier inputs and thresholds against current roadway conditions.",
    "system": "Inspect recent deploys, runtime logs, and subsystem health endpoints.",
    "validator": "Compare primary YOLO output against the heavier shadow model, review evidence on both sides, and queue disagreements for labeling.",
}

# Fallback "impact" copy per category. Individual detectors may override.
_DEFAULT_IMPACT_BY_CATEGORY = {
    "perception": "Perception quality is degraded, so real conflicts may be missed and noisy alerts may increase.",
    "drift": "Operators may lose trust because alert precision is degrading or becoming unmeasurable.",
    "llm": "Narration, enrichment, and investigation workflows will become slower, noisier, or unavailable.",
    "stream": "Live detection coverage is reduced because frames are not moving through the pipeline reliably.",
    "scene": "Context-aware thresholds may become unreliable, increasing false positives or missed conflicts.",
    "system": "The dashboard may report misleading health information until the underlying issue is fixed.",
    "validator": "The primary detector disagrees with the shadow model, suggesting false alerts or missed events that warrant labeling review.",
}


# ----- small utilities -----

def _slugify(text: str) -> str:
    """Turn a free-form title into a URL-safe, fingerprint-friendly slug.

    Lowercases the input, replaces every run of non-alphanumeric
    characters with a single ``-``, and trims any leading/trailing
    ``-``. Example: ``"LLM Error Rate!"`` -> ``"llm-error-rate"``.

    The leading underscore in the name is a Python convention that
    means "module-private" — readers should treat this as an internal
    helper, not part of the public API. (Python doesn't enforce this;
    it's just a social signal.) Returns ``"finding"`` as a safe
    fallback if the input is empty or all punctuation, so we never
    produce an empty fingerprint segment.
    """
    text = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return text or "finding"


def severity_rank(severity: str) -> int:
    """Return a numeric rank for a severity string (higher == more severe).

    Used by :func:`group_findings` when many observations collapse into
    one incident — the grouped row takes the *worst* severity ever seen
    for that fingerprint, so we need a way to compare strings like
    ``"error"`` vs ``"warning"`` numerically. Unknown / missing
    severities rank ``0`` so they never win against a real severity.

    ``dict.get(key, default)`` returns the default when the key is
    missing instead of raising ``KeyError`` — a common Python idiom for
    "look up with fallback".
    """
    return _SEVERITY_ORDER.get((severity or "").lower(), 0)


def priority_score(severity: str, source: str, evidence_count: int) -> int:
    """Compute the cross-incident sort key used by the UI.

    Severity provides the base weight (error=90, warning=60, info=30);
    rule-based findings get +5 because they are deterministic (a rule
    either fires or doesn't, while AI-sourced findings are just
    hypotheses); each piece of attached evidence adds +2, capped at 5
    chips so one noisy detector can't dominate the ranking.

    Called from :func:`make_finding` and :func:`normalize_finding_payload`
    — anywhere a finding is first built or re-read from disk. The
    returned integer is stored on the finding and drives the order in
    the MonitoringPage incident list.

    ``min(max(x, 0), 5)`` is a common Python idiom for "clamp x into
    the range [0, 5]" — first bound below with ``max``, then bound
    above with ``min``.
    """
    base = {"error": 90, "warning": 60, "info": 30}.get((severity or "").lower(), 10)
    if source == "rule":
        base += 5
    return base + min(max(evidence_count, 0), 5) * 2


def evidence(label: str, value: Any, *, threshold: str | None = None, status: str = "observed") -> dict[str, str]:
    """Build a single evidence chip dict for attachment to a finding.

    Each incident card on MonitoringPage shows a small list of "evidence
    chips" — one-line facts like ``"error rate: 12% (threshold 5%)"``.
    This helper builds one such chip; detectors accumulate a list of
    them and pass the list to :func:`make_finding` as the ``evidence``
    argument.

    The ``*`` in the signature forces ``threshold`` and ``status`` to
    be passed by keyword only (e.g. ``evidence("fps", 1.3,
    threshold="2.0")``) — this prevents positional-argument mix-ups
    since ``label`` and ``value`` are already two positional slots.

    ``status`` defaults to ``"observed"`` which is elided from the output
    to keep the JSON small; use ``"breach"``, ``"trend"``, or ``"context"``
    to mark non-default semantics. ``str(value)`` is used so numeric /
    boolean values render cleanly in the UI.
    """
    item = {"label": label, "value": str(value)}
    if threshold:
        item["threshold"] = threshold
    if status != "observed":
        item["status"] = status
    return item


def top_bucket(buckets: dict[str, Any], *, prefer_low_precision: bool = False) -> tuple[str, dict[str, Any]] | None:
    """Pick the most interesting bucket from a drift breakdown.

    The drift monitor reports precision broken down by "bucket" —
    typically event type (near-miss, red-light-run, etc.) or risk
    slice. This helper scans those buckets and picks the single one
    worth surfacing on the incident card.

    When ``prefer_low_precision`` is True the *worst* slice wins (used
    to surface failing event types when reporting a problem);
    otherwise the *best-precision* slice wins (used for celebratory /
    context rows). Returns a two-element tuple ``(key, stats)`` — the
    Python way to return "more than one value" — or ``None`` if no
    usable bucket exists.

    ``isinstance(stats, dict)`` is the Python "is this value a dict?"
    check; we skip malformed rows defensively because this data can
    come from older JSONL files with slightly different shapes.
    """
    best_key = ""
    best_stats: dict[str, Any] | None = None
    best_score: float | None = None
    for key, stats in (buckets or {}).items():
        if not isinstance(stats, dict):
            continue
        precision = stats.get("precision")
        score = precision if isinstance(precision, (int, float)) else None
        if prefer_low_precision and score is not None:
            score = -score
        if best_stats is None:
            best_key = key
            best_stats = stats
            best_score = score
            continue
        if score is None:
            continue
        if best_score is None or score > best_score:
            best_key = key
            best_stats = stats
            best_score = score
    if best_stats is None:
        return None
    return best_key, best_stats


def parse_ts(ts: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp (tolerates the trailing ``Z`` form).

    Timestamps on findings are stored as strings like
    ``"2026-04-20T14:32:10.123Z"`` (the trailing ``Z`` means "UTC").
    Python's built-in ``datetime.fromisoformat`` on older 3.10 didn't
    understand ``Z``, so we rewrite it to ``+00:00`` first — the
    equivalent explicit UTC offset.

    Returns ``None`` for missing or malformed inputs so aggregation
    functions can skip bad rows instead of raising. The ``try / except
    ValueError`` pattern is Python's exception handling — run the
    code, and if ``fromisoformat`` raises ``ValueError`` (bad format)
    catch it and fall through to ``return None`` instead of crashing.
    """
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


# ----- fingerprinting -----

def fingerprint_for(category: str, title: str) -> str:
    """Compute the stable fingerprint (dedupe key) for a finding.

    A "fingerprint" here is a short string that uniquely identifies
    *the kind of problem*, independent of when it happened or what the
    exact numbers were. Two findings with the same fingerprint group
    into one incident row with ``count`` incremented — so the UI shows
    "LLM error rate (12 occurrences)" instead of 12 separate cards.

    Well-known detector titles map to canonical slash-separated
    fingerprints (``"llm/error-rate"``, ``"stream/frame-drop"``);
    unknown titles fall back to ``{category}/{slugified-title}`` so
    ad-hoc findings still dedupe across repeats. The mapping is hard-
    coded (a series of ``if`` statements) because the set of canonical
    fingerprints is small and explicit.

    Called by :func:`defaults_for` and any detector that wants to
    compute a fingerprint without going through the builder.
    """
    cat = (category or "system").lower()
    ttl = (title or "").lower()
    if cat == "llm" and "error rate" in ttl:
        return "llm/error-rate"
    if cat == "llm" and "latency" in ttl:
        return "llm/latency"
    if cat == "llm" and "zero tokens" in ttl:
        return "llm/token-instrumentation"
    if cat == "drift" and "feedback coverage" in ttl:
        return "drift/feedback-coverage"
    if cat == "drift" and "alert" in ttl:
        return "drift/precision-alert"
    if cat == "drift" and ("trending down" in ttl or "degrading" in ttl):
        return "drift/precision-degrading"
    if cat == "drift" and ("window start equals end" in ttl or "zero-duration" in ttl):
        return "drift/window-collapsed"
    if cat == "drift" and "false positive" in ttl:
        return "drift/false-positive-spike"
    if cat == "drift" and "unknown" in ttl:
        return "drift/taxonomy-unknown"
    if cat == "stream" and "frame drop rate" in ttl:
        return "stream/frame-drop"
    if cat == "stream" and "fps" in ttl:
        return "stream/fps-low"
    if cat == "stream" and ("not running" in ttl or "stalled" in ttl):
        return "stream/stalled"
    if cat == "perception" and "failed" in ttl:
        return "perception/failed"
    if cat == "perception" and "degraded" in ttl:
        return "perception/degraded"
    return f"{cat}/{_slugify(title)}"


# ----- defaults table: copy-paste ready troubleshooting per category -----

def defaults_for(category: str, title: str, severity: str) -> dict[str, Any]:
    """Derive default fields (cause, impact, steps, commands) for a finding.

    Every finding needs owner/runbook/impact/cause/steps/commands so
    the operator sees a rich, actionable incident card. Rather than
    forcing each detector to repeat that boilerplate, this helper
    picks category-specific defaults based on the category and any
    keyword matches in the title. The returned dict is merged into the
    final record by :func:`normalize_finding_payload` and
    :func:`make_finding` — caller-supplied values always win, these are
    just the fallbacks.

    Returns a plain dict (not a dataclass) because the keys line up
    one-for-one with fields on :class:`WatchdogFinding` and the merge
    logic in the callers works by dict key lookup.

    ``if/elif/else`` is Python's if-then-else chain — only the first
    matching branch runs, and ``else`` handles "none of the above".
    """
    cat = (category or "system").lower()
    ttl = (title or "").lower()
    owner = _OWNER_BY_CATEGORY.get(cat, "Platform")
    runbook = _RUNBOOK_BY_CATEGORY.get(cat, _RUNBOOK_BY_CATEGORY["system"])
    impact = _DEFAULT_IMPACT_BY_CATEGORY.get(cat, _DEFAULT_IMPACT_BY_CATEGORY["system"])
    likely_cause = ""
    steps: list[str] = []
    commands: list[str] = []

    if cat == "perception":
        likely_cause = "Camera image quality has dropped below the confidence floor, often due to low light, blur, vibration, or obstruction."
        steps = [
            "Open `/api/live/perception` and confirm whether luminance, sharpness, or confidence is driving the degraded state.",
            "Compare the live feed with the physical camera install: lens cleanliness, mount vibration, and scene lighting.",
            "If the issue persists after the environment stabilizes, recalibrate perception thresholds for this camera position.",
        ]
        commands = [
            "curl http://localhost:8000/api/live/perception",
            "tail -n 120 logs/app.log | rg \"perception|quality|camera\"",
        ]
    elif cat == "drift" and "feedback coverage" in ttl:
        likely_cause = "The feedback pipeline or operator labeling loop is not producing enough verdicts to measure precision credibly."
        impact = "Drift monitoring is effectively blind, so false positives can grow without a trustworthy signal."
        steps = [
            "Open `/api/drift` and confirm `feedback_coverage`, `labeled_events`, and `total_events_in_window`.",
            "Check whether operators are receiving and submitting verdicts for recent events.",
            "Until coverage improves, treat precision numbers as weak evidence and prioritize restoring the labeling path.",
        ]
        commands = [
            "curl http://localhost:8000/api/drift",
            "tail -n 40 data/feedback.jsonl",
        ]
    elif cat == "drift" and ("alert" in ttl or "trending down" in ttl):
        likely_cause = "Recent event behavior has shifted or current thresholds are overfiring, and the feedback window now shows a material precision drop."
        steps = [
            "Inspect `/api/drift` and identify the worst-performing event type or risk slice.",
            "Review the most recent false positives from `/api/live/events` to see whether this is a threshold issue or a taxonomy problem.",
            "Queue disputed and boundary samples for relabeling before changing model thresholds.",
        ]
        commands = [
            "curl http://localhost:8000/api/drift",
            "curl http://localhost:8000/api/live/events?limit=20",
        ]
    elif cat == "drift" and ("window start equals end" in ttl or "zero-duration" in ttl):
        likely_cause = "The drift window timestamps are not advancing, which points to a bug in timestamp assignment or window initialization."
        impact = "Trend and precision calculations may be computed on a degenerate window, making the monitor misleading."
        steps = [
            "Inspect the latest drift payload and verify the start/end timestamps are advancing between checks.",
            "Trace the feedback records being used to compute the current window.",
            "Patch timestamp assignment before trusting drift trend output.",
        ]
        commands = [
            "curl http://localhost:8000/api/drift",
            "tail -n 20 data/feedback.jsonl",
        ]
    elif cat == "drift" and ("false positive" in ttl or "unknown" in ttl):
        likely_cause = "The detector is emitting events that the current taxonomy cannot classify cleanly, or the threshold is too loose for this scene."
        steps = [
            "Check recent events for `event_type=unknown` or `risk_level=unknown`.",
            "Validate the classifier path before tuning thresholds so you do not hide a labeling bug.",
            "Review disputed events and capture them for retraining.",
        ]
        commands = [
            "curl http://localhost:8000/api/live/events?limit=20",
            "curl http://localhost:8000/api/drift",
        ]
    elif cat == "llm" and "error rate" in ttl:
        likely_cause = "The LLM path is failing due to provider errors, rate limiting, auth drift, or unhealthy fallback behavior."
        steps = [
            "Open `/api/llm/stats` to confirm which call types are failing and whether errors cluster around one provider or mode.",
            "Inspect `/api/llm/recent` for the latest error strings and skip reasons.",
            "If errors are rate-limit related, reduce load or force the cheaper/faster fallback path until the provider recovers.",
        ]
        commands = [
            "curl http://localhost:8000/api/llm/stats",
            "curl http://localhost:8000/api/llm/recent",
            "tail -n 160 logs/app.log | rg \"429|anthropic|openai|llm\"",
        ]
    elif cat == "llm" and "latency" in ttl:
        likely_cause = "The provider is slow or prompt payloads have grown enough to violate the real-time budget."
        impact = "Operator-facing narration and investigation lag behind live events, which weakens real-time coaching value."
        steps = [
            "Inspect `/api/llm/stats` and compare overall latency with the slowest call type.",
            "Check whether latency jumped after a deploy or during provider backpressure.",
            "Reduce prompt size or route slow paths to a faster model while keeping detection fully local.",
        ]
        commands = [
            "curl http://localhost:8000/api/llm/stats",
            "tail -n 160 logs/app.log | rg \"429|Retrying request|HTTP Request\"",
        ]
    elif cat == "llm" and "zero tokens" in ttl:
        likely_cause = "Instrumentation for a call type is broken or responses are being dropped before token accounting runs."
        impact = "Cost and usage metrics become misleading, so tuning and incident response rely on bad data."
        steps = [
            "Inspect `/api/llm/stats` and verify the affected call type reports latency but zero tokens.",
            "Check recent LLM records to confirm whether outputs are empty or only the accounting path is broken.",
            "Fix instrumentation before using cost or throughput data for policy decisions.",
        ]
        commands = [
            "curl http://localhost:8000/api/llm/stats",
            "curl http://localhost:8000/api/llm/recent",
        ]
    elif cat == "stream":
        likely_cause = "Frames are not flowing through the reader or processing loop at the expected rate, often because the source is stalled or the host is overloaded."
        steps = [
            "Check `/api/admin/health` for `frames_read`, `frames_processed`, and `target_fps`.",
            "Confirm the stream source is still reachable and that the reader thread is alive.",
            "If the source is healthy, inspect CPU and memory pressure before reducing FPS or model load.",
        ]
        commands = [
            "curl http://localhost:8000/api/admin/health",
            "tail -n 160 logs/app.log | rg \"stream|reader|fps|buffer\"",
        ]
    else:
        likely_cause = "A subsystem health signal crossed its expected operating range and needs investigation."
        steps = [
            "Review the latest evidence attached to this finding.",
            "Open the related health endpoint and compare it with the previous healthy state.",
            "Use the runtime logs to determine whether this is a regression, resource issue, or bad input.",
        ]
        commands = ["tail -n 160 logs/app.log"]

    return {
        "owner": owner,
        "runbook": runbook,
        "impact": impact,
        "likely_cause": likely_cause,
        "investigation_steps": steps,
        "debug_commands": commands,
        "fingerprint": fingerprint_for(cat, title),
        "priority_score": priority_score(severity, "rule", evidence_count=0),
    }


# ----- dataclass: WatchdogFinding -----

@dataclass
class WatchdogFinding:
    """Canonical in-memory representation of one watchdog observation.

    This is a ``@dataclass``, so Python auto-generates ``__init__``,
    ``__repr__``, and ``__eq__`` from the annotated fields below. That
    means you can write ``WatchdogFinding(severity="error", ...)`` and
    the constructor "just works" without us writing one by hand.

    Flows from detectors -> :func:`normalize_finding` -> the JSONL
    writer, and (after grouping) onto the operator's incident queue.
    Required fields (``severity``, ``category``, ``title``, ``detail``)
    have no defaults; everything else defaults to sensible empties so
    constructing a finding with just the required fields still yields
    a valid record.

    Field guide (most important only):
        severity      — ``"error"`` / ``"warning"`` / ``"info"``; drives
                        the colored chip on the incident card.
        category      — coarse bucket (``"llm"``, ``"perception"``,
                        ``"stream"``...) used to select owner + runbook.
        title         — short headline shown on the card.
        detail        — human-readable sentence explaining the
                        observation.
        fingerprint   — stable dedupe key; see :func:`fingerprint_for`.
        source        — ``"rule"`` (deterministic detector) or ``"ai"``
                        (LLM-inferred hypothesis).
        cause_confidence — ``"observed"`` vs ``"inferred"``; set to
                        ``"inferred"`` for AI findings so the UI never
                        presents them with rule-level authority.
        evidence      — list of chip dicts (label/value/threshold).
        ts            — ISO-8601 UTC timestamp; auto-set via
                        ``default_factory`` to "now" at construction.
        snapshot_id   — random 12-char hex id so two findings emitted
                        in the same millisecond can still be
                        distinguished.

    Fields with ``field(default_factory=...)``: a mutable default like
    ``[]`` or the current timestamp must be produced *per instance*,
    not shared across instances. ``default_factory`` takes a zero-arg
    callable (often a ``lambda`` — an anonymous one-line function) and
    calls it once every time a new ``WatchdogFinding`` is built.
    """

    severity: str
    category: str
    title: str
    detail: str
    suggestion: str = ""
    impact: str = ""
    likely_cause: str = ""
    owner: str = ""
    runbook: str = ""
    fingerprint: str = ""
    source: str = "rule"
    cause_confidence: str = "observed"
    priority_score: int = 0
    evidence: list[dict[str, str]] = field(default_factory=list)
    investigation_steps: list[str] = field(default_factory=list)
    debug_commands: list[str] = field(default_factory=list)
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    snapshot_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def as_dict(self) -> dict:
        """Return the finding as a plain JSON-safe dict.

        ``dataclasses.asdict`` recursively walks the dataclass and
        converts it (plus any nested dataclasses, lists, dicts) into
        plain Python dicts / lists / primitives — the exact shape
        Python's JSON serializer can emit. Used by the JSONL writer
        and by :func:`normalize_finding` when it needs to round-trip
        the finding through :func:`normalize_finding_payload`.
        """
        return asdict(self)


# ----- normalization -----

def normalize_finding_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Coerce a raw finding dict into the canonical shape used by the UI.

    Called both when a fresh finding is persisted and when an existing
    ``.jsonl`` row is read back, so historical rows with missing fields
    still render correctly. For each field, if the payload already
    supplies a value we keep it; otherwise we fall back to the
    category-specific default computed by :func:`defaults_for`.

    Takes and returns plain dicts (not :class:`WatchdogFinding`
    instances) because the watchdog writer and reader work with
    ``dict`` rows straight from JSONL — this function is the single
    bottleneck where every row (new or historical) gets its shape
    fixed up.

    The special AI-safety rule: findings with ``source == "ai"`` are
    always marked ``cause_confidence == "inferred"`` so the UI never
    presents LLM-generated hypotheses with the authority of a
    deterministic rule match.
    """
    severity = (payload.get("severity") or "info").lower()
    category = payload.get("category") or "system"
    title = payload.get("title") or "Watchdog finding"
    detail = payload.get("detail") or ""
    defaults = defaults_for(category, title, severity)

    items = [
        {k: str(v) for k, v in item.items()}
        for item in (payload.get("evidence") or [])
        if isinstance(item, dict) and item.get("label") and item.get("value") is not None
    ]
    source = payload.get("source") or "rule"
    priority = payload.get("priority_score")
    if not isinstance(priority, int):
        priority = priority_score(severity, source, len(items))

    return {
        "severity": severity,
        "category": category,
        "title": title,
        "detail": detail,
        "suggestion": payload.get("suggestion") or "",
        "impact": payload.get("impact") or defaults["impact"],
        "likely_cause": payload.get("likely_cause") or defaults["likely_cause"],
        "owner": payload.get("owner") or defaults["owner"],
        "runbook": payload.get("runbook") or defaults["runbook"],
        "fingerprint": payload.get("fingerprint") or defaults["fingerprint"],
        "source": source,
        # AI-sourced findings MUST be labeled as inferred hypotheses so the
        # UI never presents them with the authority of a rule match.
        "cause_confidence": payload.get("cause_confidence") or ("inferred" if source == "ai" else "observed"),
        "priority_score": priority,
        "evidence": items,
        "investigation_steps": payload.get("investigation_steps") or defaults["investigation_steps"],
        "debug_commands": payload.get("debug_commands") or defaults["debug_commands"],
        "ts": payload.get("ts") or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "snapshot_id": payload.get("snapshot_id") or uuid.uuid4().hex[:12],
    }


def normalize_finding(finding: WatchdogFinding) -> WatchdogFinding:
    """Round-trip a :class:`WatchdogFinding` through the payload normalizer.

    Convert the finding to a dict with :meth:`WatchdogFinding.as_dict`,
    pass it through :func:`normalize_finding_payload` (which fills any
    missing defaults), and reconstruct a new :class:`WatchdogFinding`
    from the result. Useful when a detector builds a finding by hand
    and wants the same default-filling treatment the JSONL path gets.

    ``WatchdogFinding(**payload)`` is Python's "unpack keyword
    arguments" syntax — equivalent to writing
    ``WatchdogFinding(severity=payload["severity"],
    category=payload["category"], ...)`` for every key in the dict.
    """
    payload = normalize_finding_payload(finding.as_dict())
    return WatchdogFinding(**payload)


# ----- aggregation / grouping -----

def group_findings(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse raw findings into one row per fingerprint (the incident view).

    This is what turns N repeat observations of the same symptom into
    a single incident with ``count = N``, ``first_seen_ts`` /
    ``last_seen_ts``, worst-seen severity, and a ``latest`` payload
    for drill-down. It's what the MonitoringPage incident list and
    the TopBar watchdog badge are actually reading.

    Algorithm: walk every record, compute its fingerprint, and either
    start a new group (first time we've seen that fingerprint) or
    merge into the existing group (bump count, expand time window,
    keep the worst-seen severity, and replace ``latest`` if this
    record is newer than the previous "latest").

    The ``_latest_dt`` key with the leading underscore is an internal
    scratch field — we store the parsed ``datetime`` here to avoid
    re-parsing the string on every comparison, then callers can
    either keep or drop it depending on whether they need sortable
    datetime objects.

    Returns: a list of incident dicts (one per unique fingerprint)
    in insertion order. ``list(groups.values())`` is the Python way
    to get a list of all the values in a dict.
    """
    groups: dict[str, dict[str, Any]] = {}
    for record in records:
        item = normalize_finding_payload(record)
        key = item["fingerprint"]
        group = groups.get(key)
        ts = parse_ts(item["ts"])
        if group is None:
            groups[key] = {
                "fingerprint": key,
                "severity": item["severity"],
                "category": item["category"],
                "title": item["title"],
                "owner": item["owner"],
                "count": 1,
                "first_seen_ts": item["ts"],
                "last_seen_ts": item["ts"],
                "latest": item,
                "_latest_dt": ts,
            }
            continue
        group["count"] += 1
        if severity_rank(item["severity"]) > severity_rank(group["severity"]):
            group["severity"] = item["severity"]
        first_seen_dt = parse_ts(group["first_seen_ts"])
        if ts and (first_seen_dt is None or ts < first_seen_dt):
            group["first_seen_ts"] = item["ts"]
        latest_dt = group.get("_latest_dt")
        if ts and (latest_dt is None or ts > latest_dt):
            group["last_seen_ts"] = item["ts"]
            group["category"] = item["category"]
            group["title"] = item["title"]
            group["owner"] = item["owner"]
            group["latest"] = item
            group["_latest_dt"] = ts
    return list(groups.values())


# ----- finding builder (shared by rules.py and ai.py) -----

def make_finding(
    *,
    severity: str,
    category: str,
    title: str,
    detail: str,
    suggestion: str,
    snapshot_id: str,
    impact: str = "",
    likely_cause: str = "",
    fingerprint: str | None = None,
    evidence: list[dict[str, str]] | None = None,
    investigation_steps: list[str] | None = None,
    debug_commands: list[str] | None = None,
    source: str = "rule",
    cause_confidence: str | None = None,
) -> WatchdogFinding:
    """Construct a WatchdogFinding with category defaults already applied.

    This is the preferred public builder — called by every detector
    in [file](backend/services/watchdog/rules.py) and
    [file](backend/services/watchdog/ai.py) instead of constructing
    :class:`WatchdogFinding` directly. It fills in the missing
    boilerplate (owner team, runbook URL, impact copy, default
    investigation steps, etc.) from :func:`defaults_for` so detectors
    only supply the parts that differ per observation.

    All arguments are keyword-only (because of the leading ``*`` in
    the signature) — callers must write ``make_finding(severity=...,
    category=..., ...)``. This prevents confusing positional mix-ups
    given the large number of parameters.

    Unspecified ``impact`` / ``likely_cause`` / ``investigation_steps``
    / ``debug_commands`` / ``fingerprint`` fall back to the per-category
    defaults from :func:`defaults_for`. ``cause_confidence`` defaults to
    ``"inferred"`` for AI-sourced findings (so the UI never treats
    them as deterministic) and ``"observed"`` for rule findings.

    ``evidence or []`` is a common Python idiom for "use this if it's
    truthy, else an empty list" — protects against a caller passing
    ``None``.
    """
    defaults = defaults_for(category, title, severity)
    items = evidence or []
    return WatchdogFinding(
        severity=severity,
        category=category,
        title=title,
        detail=detail,
        suggestion=suggestion,
        impact=impact or defaults["impact"],
        likely_cause=likely_cause or defaults["likely_cause"],
        owner=defaults["owner"],
        runbook=defaults["runbook"],
        fingerprint=fingerprint or defaults["fingerprint"],
        source=source,
        cause_confidence=cause_confidence or ("inferred" if source == "ai" else "observed"),
        priority_score=priority_score(severity, source, len(items)),
        evidence=items,
        investigation_steps=investigation_steps or defaults["investigation_steps"],
        debug_commands=debug_commands or defaults["debug_commands"],
        snapshot_id=snapshot_id,
    )
