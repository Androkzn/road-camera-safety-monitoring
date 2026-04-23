"""Settings Console — baseline + impact engine.

Captures a `WindowStats` snapshot before any settings change, then keeps
sampling the live event ring after the change to compute deterministic
deltas with explicit comparability gates.

Two metric classes are kept distinct (per plan §S4):

* **immediate** — counts and distributions readable from the live event
  buffer the moment they arrive (event-rate, severity ratios, scene mix,
  quality mix, confidence percentiles).
* **lagging** — anything that needs operator feedback (drift precision,
  FP rate from feedback). Surfaced separately and labeled
  ``"awaiting feedback"`` until enough verdicts accrue.

Comparability between baseline and after-window is gated by the algorithm
spelled out in plan §S4: minimum sample size, scene-mix Jensen-Shannon
divergence, and quality-state similarity. The output ``confidence_tier``
is one of ``"high" | "medium" | "low" | "insufficient"``.

Persistence: every tick upserts the session into
:mod:`backend.services.settings_db` so a server restart inside the
monitoring window does not lose the operator's experiment.

Python idioms used in this file (explained once)
------------------------------------------------
- ``@dataclass`` : decorator that auto-generates ``__init__`` / ``__repr__``
  from typed class attributes. ``field(default_factory=...)`` lets a field
  default to a *new* mutable value per instance (never share a list/dict
  between instances — classic Python footgun).
- ``X | None`` : PEP 604 union type hint, "X or None".
- ``from __future__ import annotations`` : makes all type hints lazy
  strings, so modern syntax works on older Python and forward refs work.
- ``Callable[[float, float], Mapping[str, Any]]`` : a function that takes
  two floats and returns a mapping. Functions are first-class values here
  so callers can inject custom data sources without tight coupling.
- ``asdict(self)`` : recursively converts a dataclass to a plain dict,
  for JSON serialization.
- ``getattr(obj, name)`` : dynamic attribute read used to iterate the
  same set of field names across baseline and after-window instances.

UI connection
-------------
Page: SettingsPage — [file](frontend/src/features/settings/SettingsPage.tsx).
UI element: The impact card on the right column of SettingsPage —
specifically the "before vs after" deltas, severity bars, the
high/medium/low/insufficient confidence pill, and the recommendation
sentence. This module computes all of those numbers.
Consumed by: Exposed via ``/api/settings/impact`` and consumed by the
``useImpact`` hook
([file](frontend/src/features/settings/hooks/useImpact.ts)) which feeds
the ``ImpactCard`` component on SettingsPage.
"""

from __future__ import annotations

import math
import secrets
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterable, Mapping

from backend.services import settings_db


# ---------------------------------------------------------------------------
# Tunables for the engine itself (intentionally NOT in SETTINGS_SPEC)
# ---------------------------------------------------------------------------
# These are engine internals — not user-configurable through the Settings
# Console (that would make the comparability gates themselves game-able).
# MIN_BASELINE_EVENTS / MIN_AFTER_EVENTS: below 20 events the severity-ratio
# and percentile estimates are too noisy to trust; comparability tier drops
# to "low" automatically.
MIN_BASELINE_EVENTS = 20
MIN_AFTER_EVENTS = 20
# MIN_FEEDBACK: operator verdicts needed before FP rate can be reported
# from feedback rather than a proxy estimate.
MIN_FEEDBACK = 5
# Jensen-Shannon divergence between scene-mix distributions in [0, 1].
# Above 0.20 the two windows saw materially different scene compositions
# (e.g. baseline was highway + after-window was urban) — any deltas in
# event rate become confounded by scene mix rather than the settings
# change, so comparability tier is capped to medium with a reason code.
SCENE_JSD_THRESHOLD = 0.20         # above => "scene_mix_drift" reason
# Histogram-intersection similarity floor for quality state distributions
# (nominal/degraded/failed). Below 0.6 the two windows had materially
# different camera conditions and comparability is forced to low.
QUALITY_SIMILARITY_FLOOR = 0.6     # below => "quality_drift" reason
# Candidate baseline lookback windows (in seconds). We try each in order
# and accept the first that meets MIN_BASELINE_EVENTS — 5 min first for
# freshness, up to 30 min as a last-resort widening for sparse streams.
WINDOW_LOOKBACKS_SEC = (300.0, 600.0, 1200.0, 1800.0)
# If an operator lands a second settings change within 30 s of the first,
# fold both into one session so the baseline isn't overwritten by a
# mid-experiment tweak.
COALESCE_WINDOW_SEC = 30.0
# How often the engine recomputes the after-window stats (15 s).
IMPACT_TICK_SEC = 15.0
# Sessions auto-archive after 1 h so the UI doesn't show stale
# "monitoring" banners indefinitely.
IMPACT_SESSION_MAX_AGE_SEC = 3600.0
# 10 min before max-age we switch to an "unattended" banner so operators
# know the window is about to close.
UNATTENDED_BANNER_LEAD_SEC = 600.0


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------
@dataclass
class WindowStats:
    """Deterministic stats over one observation window (baseline or after).

    One instance per window — you'll see a pair (baseline + after) attached
    to every active :class:`ImpactReport`. All percentile fields are
    ``None`` when the window contains no data for that metric (kept as
    ``None`` rather than 0.0 so the UI can render "—").

    Fields with ``= None`` defaults are truly optional; the mutable
    defaults (``dict``, ``list``) must use ``field(default_factory=...)``
    — using a bare ``{}`` would share one dict across every instance.
    """

    window_start_ts: float
    window_end_ts: float
    duration_sec: float
    sample_size: int
    event_rate_per_min: float
    severity_counts: dict[str, int] = field(default_factory=dict)
    severity_ratios: dict[str, float] = field(default_factory=dict)
    confidence_p50: float | None = None
    confidence_p95: float | None = None
    ttc_p50: float | None = None
    ttc_p95: float | None = None
    distance_p50_m: float | None = None
    distance_p95_m: float | None = None
    scene_distribution: dict[str, float] = field(default_factory=dict)
    quality_distribution: dict[str, float] = field(default_factory=dict)
    fp_rate: float | None = None
    fp_rate_source: str = "insufficient"  # "feedback" | "proxy" | "insufficient"
    # --- operational metrics (from ops_sampler; None when unavailable) ----
    # These describe how the pipeline is running — actual fps, CPU, LLM
    # spend — as opposed to the event-derived fields above. They let an
    # operator see whether a setting change made things cheaper / faster /
    # heavier, not just whether it shifted the risk tier distribution.
    actual_fps_p50: float | None = None
    actual_fps_p95: float | None = None
    frames_dropped_ratio_p95: float | None = None
    cpu_p50: float | None = None
    cpu_p95: float | None = None
    memory_p95: float | None = None
    llm_cost_usd_per_min: float | None = None
    llm_tokens_per_min: float | None = None
    llm_latency_p95_ms: float | None = None
    llm_skip_rate: float | None = None
    llm_calls: int = 0
    ops_samples: int = 0

    def to_dict(self) -> dict[str, Any]:
        """JSON-serialisable representation.

        ``asdict`` recurses through nested dataclasses (none here but
        future-proof) and copies lists/dicts so the caller cannot mutate
        our internal state.
        """
        return asdict(self)


@dataclass
class ImpactReport:
    """One ``GET /api/settings/impact`` payload.

    The complete response the frontend renders on the impact card: the
    before/after settings diff, both windows' stats, their percentage
    deltas, a comparability tier, and optional narrative / recommendation
    from the LLM advisory layer (``analyze_settings_impact`` in ``llm.py``).

    ``state`` transitions: monitoring -> monitoring_unattended -> archived.
    """

    audit_id: str
    change_ts: float
    actor_label: str
    before: dict[str, Any]
    after: dict[str, Any]
    changed_keys: list[str]
    baseline: WindowStats | None
    after_window: WindowStats | None
    deltas: dict[str, float] = field(default_factory=dict)
    confidence_tier: str = "insufficient"  # high | medium | low | insufficient
    confidence_reasons: list[str] = field(default_factory=list)
    immediate_metrics: list[str] = field(default_factory=list)
    lagging_metrics: list[str] = field(default_factory=list)
    state: str = "monitoring"
    warnings: list[str] = field(default_factory=list)
    last_good: dict[str, Any] = field(default_factory=dict)
    narrative: str | None = None
    recommendation: str | None = None  # keep | revert | monitor

    def to_dict(self) -> dict[str, Any]:
        """JSON-serialisable form; explicitly expands nested dataclasses.

        ``asdict`` would handle nested dataclasses automatically, but
        calling the inner ``to_dict()`` keeps the field ordering stable
        and future-proofs against adding non-dataclass fields.
        """
        out = asdict(self)
        if self.baseline is not None:
            out["baseline"] = self.baseline.to_dict()
        if self.after_window is not None:
            out["after_window"] = self.after_window.to_dict()
        return out


# ---------------------------------------------------------------------------
# Math helpers
# ---------------------------------------------------------------------------
def _percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile (no interpolation). ``p`` is in 0..100.

    Good enough for an operator dashboard and stable across tiny samples
    — a median-of-3 will return the middle element rather than averaging.
    Returns ``None`` on empty input so callers can render "—" in the UI.
    """
    if not values:
        return None
    s = sorted(values)
    # Clamp to valid index range: multiply fractional position by (n-1),
    # round, then pin into [0, n-1].
    idx = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return float(s[idx])


def _normalize_dist(counts: Mapping[str, int]) -> dict[str, float]:
    """Turn a count dict into a probability distribution that sums to 1.

    Empty input returns ``{}`` (not a divide-by-zero). Used for scene and
    quality mixes before they feed the Jensen-Shannon gate.
    """
    total = sum(counts.values())
    if total == 0:
        return {}
    # Dict comprehension: ``{k: expr for k, v in ...}`` — concise map.
    return {k: v / total for k, v in counts.items()}


def jensen_shannon_distance(p: Mapping[str, float], q: Mapping[str, float]) -> float:
    """Symmetrized KL divergence in [0, 1].

    Returns 0.0 when both distributions are identical (or both empty),
    1.0 when fully disjoint. Uses base-2 log so the value is bounded by 1.

    Why JSD and not raw KL? KL is asymmetric and blows up to infinity
    when ``q`` has a zero where ``p`` doesn't. JSD averages both directions
    against a midpoint distribution ``m``, which keeps it symmetric and
    finite — the exact property a comparability gate needs.
    """
    keys = set(p) | set(q)  # Set-union via ``|``: all keys seen in either dist.
    if not keys:
        return 0.0

    def _kl(a: Mapping[str, float], b: Mapping[str, float]) -> float:
        """Inner KL divergence; both args should have positive-mass entries."""
        total = 0.0
        for k in keys:
            ak = a.get(k, 0.0)
            bk = b.get(k, 0.0)
            # Skip zero-mass keys to avoid log(0) / 0*log(0); limit theory
            # says these contribute 0 to the sum.
            if ak > 0 and bk > 0:
                total += ak * math.log2(ak / bk)
        return total

    # ``m`` is the pointwise midpoint distribution — the reference both
    # p and q are compared to.
    m = {k: 0.5 * (p.get(k, 0.0) + q.get(k, 0.0)) for k in keys}
    jsd = 0.5 * _kl(p, m) + 0.5 * _kl(q, m)
    # Numerical floor: tiny negative values from rounding can sneak in.
    return max(0.0, min(1.0, jsd))


# ---------------------------------------------------------------------------
# Window computation
# ---------------------------------------------------------------------------
def compute_window(
    events: Iterable[dict[str, Any]],
    *,
    start_ts: float,
    end_ts: float,
    ops_stats: Mapping[str, Any] | None = None,
) -> WindowStats:
    """Roll a list of event dicts into a :class:`WindowStats`.

    Each event is expected to expose (best-effort) the fields:
    ``risk`` (low/medium/high), ``timestamp_sec`` or ``ts``,
    ``confidence``, ``ttc_sec``, ``distance_m``, ``scene_label`` /
    ``scene``, ``quality_state`` / ``perception_state``. Missing fields
    are tolerated — the corresponding stat is just ``None``.

    ``ops_stats`` is the dict returned by
    :meth:`OpsSampler.window_stats` (or ``None`` when the sampler is not
    wired). Its fields are copied into the operational-metric slots on
    the returned :class:`WindowStats`.
    """
    # Floor duration at 1 ms so the downstream rate_per_min math cannot
    # divide by zero even on a degenerate equal start/end window.
    duration = max(0.001, end_ts - start_ts)
    # ``Counter`` is a dict subclass that counts items; ``Counter()[k] += 1``
    # starts at 0 automatically, no existence check needed.
    severity_counts: Counter[str] = Counter()
    confidences: list[float] = []
    ttcs: list[float] = []
    dists: list[float] = []
    scenes: Counter[str] = Counter()
    quality: Counter[str] = Counter()

    sample = 0
    for ev in events:
        # Tolerate two timestamp field names (``timestamp_sec`` vs ``ts``)
        # because events can come from different producers in this codebase.
        ts = float(ev.get("timestamp_sec") or ev.get("ts") or 0.0)
        # Skip events outside the requested window (0.0 timestamp means
        # "no timestamp recorded" and is accepted — defensive).
        if ts and (ts < start_ts or ts > end_ts):
            continue
        sample += 1
        severity_counts[str(ev.get("risk") or ev.get("severity") or "unknown")] += 1
        c = ev.get("confidence")
        # ``isinstance(c, (int, float))`` accepts both numeric types; the
        # downstream ``float(c)`` unifies them. Events with missing or
        # string-typed fields are skipped rather than raising.
        if isinstance(c, (int, float)):
            confidences.append(float(c))
        t = ev.get("ttc_sec")
        if isinstance(t, (int, float)):
            ttcs.append(float(t))
        d = ev.get("distance_m")
        if isinstance(d, (int, float)):
            dists.append(float(d))
        scene = ev.get("scene_label") or ev.get("scene")
        if scene:
            scenes[str(scene)] += 1
        q = ev.get("quality_state") or ev.get("perception_state")
        if q:
            quality[str(q)] += 1

    # Events per minute — multiply fractional rate by 60 for display units.
    rate_per_min = (sample / duration) * 60.0 if duration > 0 else 0.0
    ops = ops_stats or {}
    return WindowStats(
        window_start_ts=start_ts,
        window_end_ts=end_ts,
        duration_sec=duration,
        sample_size=sample,
        event_rate_per_min=rate_per_min,
        severity_counts=dict(severity_counts),
        severity_ratios=_normalize_dist(severity_counts),
        confidence_p50=_percentile(confidences, 50),
        confidence_p95=_percentile(confidences, 95),
        ttc_p50=_percentile(ttcs, 50),
        ttc_p95=_percentile(ttcs, 95),
        distance_p50_m=_percentile(dists, 50),
        distance_p95_m=_percentile(dists, 95),
        scene_distribution=_normalize_dist(scenes),
        quality_distribution=_normalize_dist(quality),
        actual_fps_p50=ops.get("actual_fps_p50"),
        actual_fps_p95=ops.get("actual_fps_p95"),
        frames_dropped_ratio_p95=ops.get("frames_dropped_ratio_p95"),
        cpu_p50=ops.get("cpu_p50"),
        cpu_p95=ops.get("cpu_p95"),
        memory_p95=ops.get("memory_p95"),
        llm_cost_usd_per_min=ops.get("llm_cost_usd_per_min"),
        llm_tokens_per_min=ops.get("llm_tokens_per_min"),
        llm_latency_p95_ms=ops.get("llm_latency_p95_ms"),
        llm_skip_rate=ops.get("llm_skip_rate"),
        llm_calls=int(ops.get("llm_calls", 0) or 0),
        ops_samples=int(ops.get("samples", 0) or 0),
    )


# ---------------------------------------------------------------------------
# Comparability gates
# ---------------------------------------------------------------------------
def evaluate_confidence(
    baseline: WindowStats | None,
    after: WindowStats | None,
) -> tuple[str, list[str]]:
    """Apply the gate algorithm; returns ``(tier, reasons)``.

    Starts optimistic (``"high"``) and caps downward when gates trip.
    The returned ``reasons`` list is a set of short codes the UI maps
    to operator-facing explanations — non-empty means the comparison
    has known caveats.

    Gates
    -----
    1. sample-size floor (``MIN_BASELINE_EVENTS`` / ``MIN_AFTER_EVENTS``)
       -> tier capped to "low" and ``insufficient_events`` reason.
    2. Scene-mix JSD above ``SCENE_JSD_THRESHOLD``
       -> capped to "medium" and ``scene_mix_drift``.
    3. Quality-state similarity below ``QUALITY_SIMILARITY_FLOOR``
       -> capped to "low" and ``quality_drift``.
    """
    reasons: list[str] = []
    if baseline is None or after is None:
        return "insufficient", ["no_baseline_or_after"]
    tier = "high"
    if baseline.sample_size < MIN_BASELINE_EVENTS or after.sample_size < MIN_AFTER_EVENTS:
        reasons.append("insufficient_events")
        tier = "low"
    if baseline.scene_distribution and after.scene_distribution:
        jsd = jensen_shannon_distance(baseline.scene_distribution, after.scene_distribution)
        if jsd > SCENE_JSD_THRESHOLD:
            reasons.append("scene_mix_drift")
            tier = _cap_tier(tier, "medium")
    if baseline.quality_distribution and after.quality_distribution:
        # Histogram intersection: sum of per-key min probabilities. Equals
        # 1.0 when the two distributions are identical, 0.0 when disjoint.
        # Generator expression inside ``sum()`` avoids materializing a
        # list for what can be a large key set.
        same = sum(
            min(baseline.quality_distribution.get(k, 0.0), after.quality_distribution.get(k, 0.0))
            for k in set(baseline.quality_distribution) | set(after.quality_distribution)
        )
        if same < QUALITY_SIMILARITY_FLOOR:
            reasons.append("quality_drift")
            tier = _cap_tier(tier, "low")
    return tier, reasons


def _cap_tier(current: str, cap: str) -> str:
    """Clamp ``current`` tier so it never exceeds ``cap`` (monotonic downgrade).

    Used by the gate evaluator to ratchet confidence down — once a tier
    has been lowered by one gate, a later gate can only lower it further,
    never raise it back.
    """
    rank = {"high": 3, "medium": 2, "low": 1, "insufficient": 0}
    return current if rank[current] <= rank[cap] else cap


# ---------------------------------------------------------------------------
# Delta computation
# ---------------------------------------------------------------------------
_DELTA_FIELDS = (
    "event_rate_per_min",
    "confidence_p50",
    "confidence_p95",
    "ttc_p50",
    "ttc_p95",
    "distance_p50_m",
    "distance_p95_m",
    # Operational metrics (from ops_sampler). Same percentage-delta logic
    # as the event-derived fields; ``compute_deltas`` skips any field
    # where either baseline or after is ``None``, so an unwired sampler
    # simply produces no ops deltas.
    "actual_fps_p50",
    "actual_fps_p95",
    "frames_dropped_ratio_p95",
    "cpu_p50",
    "cpu_p95",
    "memory_p95",
    "llm_cost_usd_per_min",
    "llm_tokens_per_min",
    "llm_latency_p95_ms",
    "llm_skip_rate",
)


def compute_deltas(baseline: WindowStats, after: WindowStats) -> dict[str, float]:
    """Percentage delta when baseline is non-zero, absolute otherwise.

    ``getattr(obj, name)`` reads a named attribute dynamically, letting
    us iterate the same field names across both windows without
    repeating the list. Any field that is ``None`` on either side is
    skipped — we never show a delta when one side has no data.

    The fall-through to absolute deltas on zero baselines means a metric
    that went from 0 to N shows up as ``N`` (not infinity), which the UI
    renders alongside a "new signal" badge.
    """
    deltas: dict[str, float] = {}
    for f in _DELTA_FIELDS:
        b = getattr(baseline, f)
        a = getattr(after, f)
        if a is None or b is None:
            continue
        if b != 0:
            # Percent change relative to baseline magnitude; ``abs(b)``
            # ensures the sign comes from (a - b), not from b itself.
            deltas[f] = (a - b) / abs(b) * 100.0
        else:
            deltas[f] = float(a)
    return deltas


# ---------------------------------------------------------------------------
# ImpactMonitor
# ---------------------------------------------------------------------------
class ImpactMonitor:
    """Single active session tracker.

    The engine is intentionally simple — one active session at a time. A new
    apply within :data:`COALESCE_WINDOW_SEC` of the prior change folds into
    the same session (the original ``before`` is preserved so revert lands
    on the *first* pre-change snapshot, not the latest).
    """

    def __init__(
        self,
        events_source: Callable[[], list[dict[str, Any]]],
        *,
        ops_stats_fn: Callable[[float, float], Mapping[str, Any]] | None = None,
    ):
        """Construct the monitor.

        Args:
            events_source: Callable returning the live event ring buffer.
                Called once per window aggregation; must be cheap.
            ops_stats_fn: Optional callable ``(start_ts, end_ts) -> ops_stats_dict``
                as returned by :meth:`OpsSampler.window_stats`. When
                ``None``, windows carry only event-derived fields —
                operational metrics stay ``None`` and the UI renders "—".
        """
        self._events_source = events_source
        self._ops_stats_fn = ops_stats_fn
        self._session: dict[str, Any] | None = None

    def _ops_for(self, start_ts: float, end_ts: float) -> Mapping[str, Any] | None:
        """Safe call into the ops-sampler stats function, if wired.

        Swallows every exception so a broken sampler can never take down
        the impact engine; ``None`` is interpreted downstream as "no ops
        data for this window" and the metrics render as "—".
        """
        if self._ops_stats_fn is None:
            return None
        try:
            return self._ops_stats_fn(start_ts, end_ts)
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def on_settings_change(
        self,
        before: dict[str, Any],
        after: dict[str, Any],
        *,
        actor_label: str,
        changed_keys: list[str],
    ) -> str:
        """Capture (or refresh) a baseline; returns the session ``audit_id``.

        Two paths:

        1. **Coalesce** — if the previous change was within
           ``COALESCE_WINDOW_SEC`` (30 s), fold this change into the
           existing session. The original ``before`` is preserved so a
           later revert lands on the pre-experiment state, not on a
           mid-experiment tweak.
        2. **New session** — otherwise snapshot the baseline (walking
           ``WINDOW_LOOKBACKS_SEC`` widths until one has enough events),
           persist it, and seed a fresh session.
        """
        now = time.time()
        if self._session and (now - self._session["change_ts"]) < COALESCE_WINDOW_SEC:
            self._session["after"] = after
            self._session["change_ts"] = now
            # Union of already-changed keys + the new change, sorted for
            # deterministic output. ``set(...) | set(...)`` is set union.
            self._session["changed_keys"] = sorted(set(self._session["changed_keys"]) | set(changed_keys))
        else:
            # ``secrets.token_hex(6)`` — cryptographically-random 12-char
            # hex id; used over uuid4 for shorter URL-friendly ids.
            audit_id = f"impact_{secrets.token_hex(6)}"
            baseline_window = self._capture_baseline(now)
            baseline_id = f"bl_{secrets.token_hex(6)}"
            settings_db.insert_baseline(
                baseline_id=baseline_id,
                audit_id=audit_id,
                settings_hash="",  # filled by API layer if needed
                captured_start=baseline_window.window_start_ts,
                captured_end=baseline_window.window_end_ts,
                sample_count=baseline_window.sample_size,
                payload=baseline_window.to_dict(),
            )
            self._session = {
                "audit_id": audit_id,
                "change_ts": now,
                "actor_label": actor_label,
                "before": before,
                "after": after,
                "changed_keys": changed_keys,
                "baseline_id": baseline_id,
                "baseline": baseline_window,
                "last_good": before,
                "state": "monitoring",
                "warnings": [],
            }
        self._persist_session()
        return self._session["audit_id"]

    def _capture_baseline(self, end_ts: float) -> WindowStats:
        """Walk ``WINDOW_LOOKBACKS_SEC`` widest-last; return the first
        that has ``>= MIN_BASELINE_EVENTS`` events, else widest anyway.

        Prefers the narrowest (freshest) lookback to reflect the state
        immediately before the change; widens only when the stream is
        sparse enough that the narrow window had too few events.
        """
        events = self._events_source()
        for lookback in WINDOW_LOOKBACKS_SEC:
            start = end_ts - lookback
            ws = compute_window(
                events,
                start_ts=start,
                end_ts=end_ts,
                ops_stats=self._ops_for(start, end_ts),
            )
            if ws.sample_size >= MIN_BASELINE_EVENTS:
                return ws
        # Last resort: widest lookback window even if under threshold.
        # We still return *something* so the UI has a baseline to compare
        # against — the comparability tier will flag "insufficient_events".
        start = end_ts - WINDOW_LOOKBACKS_SEC[-1]
        return compute_window(
            events,
            start_ts=start,
            end_ts=end_ts,
            ops_stats=self._ops_for(start, end_ts),
        )

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------
    def current_report(self) -> ImpactReport | None:
        """Return the live impact for the active session, if any."""
        if self._session is None:
            return self._restore_from_db()
        return self._build_report(self._session)

    def report_for(self, audit_id: str) -> ImpactReport | None:
        """Return a report for an arbitrary session id (active or archived)."""
        sess = settings_db.get_impact_session(audit_id)
        if sess is None:
            return None
        baseline_payload = settings_db.baseline_for_audit(audit_id)
        baseline = (
            WindowStats(**baseline_payload["payload"]) if baseline_payload else None
        )
        events = self._events_source()
        now = time.time()
        after = compute_window(
            events,
            start_ts=sess["change_ts"],
            end_ts=now,
            ops_stats=self._ops_for(sess["change_ts"], now),
        )
        return _assemble_report(sess, baseline, after)

    def _restore_from_db(self) -> ImpactReport | None:
        """Rebuild an in-memory session from the SQLite store after a restart.

        Keeps the Settings Console usable across ``uvicorn`` reloads and
        crashes — operators don't lose their experiment just because the
        process bounced. ``WindowStats(**baseline_payload["payload"])``
        uses ``**`` to unpack a dict into keyword arguments, calling the
        dataclass constructor with each stored field.
        """
        sess = settings_db.get_active_impact_session()
        if sess is None:
            return None
        # Hydrate the in-memory session for subsequent ticks.
        baseline_payload = settings_db.baseline_for_audit(sess["audit_id"])
        baseline = (
            WindowStats(**baseline_payload["payload"]) if baseline_payload else None
        )
        # ``{**sess, "extra": val}`` creates a new dict by merging — the
        # explicit keys on the right override anything with the same
        # name from ``sess``.
        self._session = {
            **sess,
            "baseline": baseline,
            "last_good": sess["before"],
            "warnings": [],
        }
        return self._build_report(self._session)

    def _build_report(self, sess: dict[str, Any]) -> ImpactReport:
        """Recompute the after-window and assemble a fresh :class:`ImpactReport`.

        Also advances the session state machine:
        ``monitoring -> monitoring_unattended -> archived`` based on
        wall-clock age. Every tick persists the updated session so a
        crash between ticks doesn't lose progress.
        """
        events = self._events_source()
        now = time.time()
        # If we crossed the unattended threshold, mark the state.
        # (max_age - lead) = 50 min in defaults; the UI flips to an
        # "unattended — auto-archive soon" banner at that point.
        if (
            sess["state"] == "monitoring"
            and (now - sess["change_ts"]) >= (IMPACT_SESSION_MAX_AGE_SEC - UNATTENDED_BANNER_LEAD_SEC)
        ):
            sess["state"] = "monitoring_unattended"
            self._persist_session()
        if (now - sess["change_ts"]) >= IMPACT_SESSION_MAX_AGE_SEC and sess["state"] != "archived":
            # Past max age -> archive and drop from memory. The stored row
            # survives in SQLite so ``report_for(audit_id)`` still works.
            sess["state"] = "archived"
            sess["archived_at"] = now
            self._persist_session()
            self._session = None
        after = compute_window(
            events,
            start_ts=sess["change_ts"],
            end_ts=now,
            ops_stats=self._ops_for(sess["change_ts"], now),
        )
        baseline = sess.get("baseline")
        report = _assemble_report(sess, baseline, after)
        sess["last_payload"] = report.to_dict()
        self._persist_session()
        return report

    def _persist_session(self) -> None:
        """Flush the current in-memory session to SQLite (upsert).

        Safe to call on every tick — the SQL uses ``ON CONFLICT`` so
        repeat calls update the same row rather than erroring on unique
        constraint.
        """
        if self._session is None:
            return
        sess = self._session
        settings_db.upsert_impact_session(
            session_id=sess["audit_id"],
            audit_id=sess["audit_id"],
            change_ts=sess["change_ts"],
            actor_label=sess["actor_label"],
            before=sess["before"],
            after=sess["after"],
            baseline_id=sess.get("baseline_id"),
            last_payload=sess.get("last_payload"),
            state=sess["state"],
            archived_at=sess.get("archived_at"),
        )

    # ------------------------------------------------------------------
    # Operator-facing controls
    # ------------------------------------------------------------------
    def revert_target(self) -> dict[str, Any] | None:
        """Return the snapshot to revert to (or ``None`` if nothing eligible)."""
        if self._session is None:
            self._restore_from_db()
        if self._session is None:
            return None
        return dict(self._session["last_good"])

    def archive_active(self) -> None:
        """Force-archive the currently active session (e.g. after rollback)."""
        if self._session is None:
            return
        self._session["state"] = "archived"
        self._session["archived_at"] = time.time()
        self._persist_session()
        self._session = None


def _assemble_report(
    sess: dict[str, Any],
    baseline: WindowStats | None,
    after: WindowStats | None,
) -> ImpactReport:
    """Glue helper: evaluate gates, compute deltas, return a typed report.

    Module-level (not a method) so ``report_for()`` can call it against
    an archived session reconstructed from SQLite without needing a live
    :class:`ImpactMonitor` instance.
    """
    tier, reasons = evaluate_confidence(baseline, after)
    # Short-circuit the delta computation when either window is missing
    # so the caller sees an empty dict (and renders "—") instead of a
    # crash on ``getattr`` against ``None``.
    deltas = compute_deltas(baseline, after) if baseline and after else {}
    immediate = [
        "event_rate_per_min",
        "severity_counts",
        "confidence_p50",
        "confidence_p95",
        "ttc_p50",
        "ttc_p95",
        "scene_distribution",
        "quality_distribution",
        # Operational — populated whenever the ops_sampler is wired. The
        # comparability gate treats these like any other immediate metric
        # (it only checks sample size + scene/quality distributions).
        "actual_fps_p95",
        "cpu_p95",
        "llm_cost_usd_per_min",
        "llm_latency_p95_ms",
    ]
    lagging = ["fp_rate", "drift_precision", "feedback_coverage"]
    return ImpactReport(
        audit_id=sess["audit_id"],
        change_ts=sess["change_ts"],
        actor_label=sess["actor_label"],
        before=sess["before"],
        after=sess["after"],
        changed_keys=sess.get("changed_keys", []),
        baseline=baseline,
        after_window=after,
        deltas=deltas,
        confidence_tier=tier,
        confidence_reasons=reasons,
        immediate_metrics=immediate,
        lagging_metrics=lagging,
        state=sess["state"],
        warnings=sess.get("warnings", []),
        last_good=sess.get("last_good", sess["before"]),
    )
