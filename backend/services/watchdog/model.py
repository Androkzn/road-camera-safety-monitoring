"""Watchdog finding model: shapes, defaults, fingerprinting, grouping.

This module owns the *data shape* of a watchdog finding and everything
needed to construct, normalize, and aggregate one. It is deliberately
free of I/O and of any detector logic so that both the rule-based
detectors ([rules.py](rules.py)) and the AI hypothesis layer
([ai.py](ai.py)) can depend on it without pulling in the rest of the
package.

Public surface (also re-exported from ``backend.services.watchdog``):

- :class:`WatchdogFinding`        — canonical dataclass.
- :func:`make_finding`            — keyword-only builder with category defaults.
- :func:`normalize_finding_payload` — coerce a dict into the canonical shape.
- :func:`group_findings`          — collapse raw findings into incidents.
- Helpers: :func:`severity_rank`, :func:`priority_score`,
  :func:`evidence`, :func:`top_bucket`, :func:`parse_ts`,
  :func:`fingerprint_for`, :func:`defaults_for`.
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
    """Turn a free-form title into a URL-safe, fingerprint-friendly slug."""
    text = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return text or "finding"


def severity_rank(severity: str) -> int:
    """Return a numeric rank for a severity string (higher == more severe)."""
    return _SEVERITY_ORDER.get((severity or "").lower(), 0)


def priority_score(severity: str, source: str, evidence_count: int) -> int:
    """Compute the cross-incident sort key used by the UI.

    Severity provides the base weight (error=90, warning=60, info=30);
    rule-based findings get +5 because they are deterministic; each piece
    of evidence adds +2, capped at 5 chips.
    """
    base = {"error": 90, "warning": 60, "info": 30}.get((severity or "").lower(), 10)
    if source == "rule":
        base += 5
    return base + min(max(evidence_count, 0), 5) * 2


def evidence(label: str, value: Any, *, threshold: str | None = None, status: str = "observed") -> dict[str, str]:
    """Build a single evidence chip dict for attachment to a finding.

    ``status`` defaults to ``"observed"`` which is elided from the output
    to keep the JSON small; use ``"breach"``, ``"trend"``, or ``"context"``
    to mark non-default semantics.
    """
    item = {"label": label, "value": str(value)}
    if threshold:
        item["threshold"] = threshold
    if status != "observed":
        item["status"] = status
    return item


def top_bucket(buckets: dict[str, Any], *, prefer_low_precision: bool = False) -> tuple[str, dict[str, Any]] | None:
    """Pick the most interesting bucket from a drift breakdown.

    When ``prefer_low_precision`` is True the worst slice wins (used to
    surface failing event types); otherwise the best-precision slice wins.
    Returns ``(key, stats)`` or ``None`` if no usable bucket exists.
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

    Returns ``None`` for missing or malformed inputs so aggregation
    functions can skip bad rows instead of raising.
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

    Two findings with the same fingerprint group into one incident row
    with ``count`` incremented. Well-known detector titles map to
    canonical slash-separated fingerprints; unknown titles fall back to
    ``{category}/{slugified-title}`` so ad-hoc findings still dedupe
    across repeats.
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

    Every finding needs owner/runbook/impact/cause/steps/commands. Rather
    than forcing each detector to repeat boilerplate, this helper picks
    defaults based on category and title keywords. The returned dict is
    merged into the final record by :func:`normalize_finding_payload` and
    :func:`make_finding`.
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

    Flows from detectors → :func:`normalize_finding` → the JSONL writer,
    and (after grouping) onto the operator's incident queue. Required
    fields (``severity``, ``category``, ``title``, ``detail``) have no
    defaults; everything else defaults to sensible empties so constructing
    a finding with just the required fields still yields a valid record.
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
        """Return the finding as a plain JSON-safe dict."""
        return asdict(self)


# ----- normalization -----

def normalize_finding_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Coerce a raw finding dict into the canonical shape used by the UI.

    Called both when a fresh finding is persisted and when an existing
    jsonl row is read back, so historical rows with missing fields still
    render correctly.
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
    """Round-trip a :class:`WatchdogFinding` through the payload normalizer."""
    payload = normalize_finding_payload(finding.as_dict())
    return WatchdogFinding(**payload)


# ----- aggregation / grouping -----

def group_findings(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse raw findings into one row per fingerprint (the incident view).

    This is what turns N repeat observations of the same symptom into a
    single incident with ``count = N``, ``first_seen_ts``/``last_seen_ts``,
    worst-seen severity, and a ``latest`` payload for drill-down.
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

    Arguments are keyword-only. Unspecified impact / likely_cause /
    investigation_steps / debug_commands / fingerprint fall back to the
    per-category defaults from :func:`defaults_for`.
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
