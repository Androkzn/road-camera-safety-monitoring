"""Claude hypothesis layer — strictly additive on top of the rule detectors.

This module asks a large-language model (Claude, via the project's
internal LLM wrapper) to look at a health snapshot and *guess* at
issues that the deterministic rule detectors in
[rules.py](rules.py) might have missed. It is intentionally the
weaker, optional half of the watchdog: if the LLM provider is down,
misconfigured, slow, or returns nonsense, this module returns an
empty list (``[]``) and the rule layer simply carries on alone. That
behaviour is an **architectural invariant** — rules are the source of
truth, AI is sprinkles on top. Do not change it without also updating
the dedupe logic in [api.py](api.py).

Every finding produced here is labelled ``source="ai"`` and
``cause_confidence="inferred"`` so the UI can style hypotheses
distinctly from the rule-based observations. The rule-wins-on-
fingerprint (and title) deduplication happens in [api.py](api.py) —
**not here** — so this module never needs to know what the rule layer
emitted.

All LLM traffic goes through [backend/services/llm.py](../llm.py),
which is the single egress point for model calls. That wrapper is
where failover, per-minute rate budgeting, circuit-breaker back-off,
and cost/token tracking live; bypassing it with a direct provider
call would break all of those at once.

Python primer
-------------
- ``from __future__ import annotations`` — a compatibility toggle that
  makes type hints (``str | None`` etc.) behave as strings at import
  time. Lets modern syntax run on older Python versions.
- ``async def`` / ``await`` — declares a coroutine. Calling the function
  does not run it; scheduling it on an asyncio event loop does. This
  module is async because the LLM call is a network round-trip, and
  we do not want to block the event loop while we wait for Claude.
- ``list[WatchdogFinding]`` — a type hint meaning "list of
  ``WatchdogFinding`` objects". Purely for documentation / type
  checkers; Python does not enforce it at runtime.
- ``try / except Exception`` — the catch-all equivalent of a generic
  "if anything goes wrong". Used deliberately here because this is a
  monitoring layer: any failure should be a no-op, never a crash.

UI connection
-------------
Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
       and the Watchdog drawer ([file](frontend/src/features/watchdog/components/WatchdogDrawer.tsx)).
UI element: Incident cards inside the Watchdog drawer. AI-sourced
       findings are rendered with a distinct "AI hypothesis" badge
       (driven by ``source == "ai"``) so operators can tell an
       inferred finding from a deterministic rule observation.
Backend route(s): Indirectly feeds ``GET /api/watchdog`` and
       ``GET /api/watchdog/recent`` — this module emits findings,
       [api.py](api.py) dedupes and persists them, and those two
       routes read the stored records back out.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from .model import WatchdogFinding, make_finding

_ANALYSIS_SYSTEM = (
    "You are an AI operations watchdog for a fleet safety system. "
    "You receive periodic health snapshots from a road-conflict detection pipeline. "
    "Analyze the data for issues, failures, anomalies, and inconsistencies. "
    "Return STRICT JSON only — an array of finding objects. Each finding has: "
    '{"severity": "error"|"warning"|"info", "category": string, "title": string, '
    '"detail": string, "suggestion": string, "likely_cause": string}. '
    "Categories: perception, drift, llm, stream, scene, system. "
    "Focus on actionable issues with operator impact. Do NOT report normal or healthy metrics as findings. "
    "Do not emit more than 3 findings. Prefer symptom-level issues over generic commentary. "
    "If everything looks healthy, return an empty array []. "
    "Be concise — title under 10 words, detail under 50 words, suggestion under 30 words. "
    "IMPORTANT: the pipeline subsamples by design. `frames_read` is the source-rate pull (native fps, typically 25–60); "
    "`frames_processed` is throttled to `target_fps` (default 2). A large read/processed gap is expected and NOT a bottleneck — "
    "only flag perception throughput issues when `frames_processed` itself falls below `target_fps`. "
    "Similarly, `llm` skips are the rate-budget back-pressure working as designed; only flag them when error_rate is high "
    "or the bucket is plainly misconfigured. "
    "MIN-SAMPLE RULE: never flag rate or ratio metrics on tiny denominators — they are statistical noise, not incidents. "
    "Specifically: do NOT emit findings about `error_rate` when `window_calls` < 5, about precision/false-positive ratios "
    "when `labeled_events` < 5, or about feedback coverage when `total_events_in_window` < 20. "
    "Rule-based detectors already cover these cases with correct thresholds; duplicating them at low n creates alert fatigue."
)


async def ai_analyze(snapshot: dict, prev_snapshot: dict | None) -> list[WatchdogFinding]:
    """Ask Claude to hypothesise incidents from a snapshot; best-effort.

    This is the single public entry point of the AI hypothesis layer.
    The watchdog loop in [api.py](api.py) calls it once per tick,
    *after* the rule layer has already run, and merges the return
    value in after deduplication.

    ``async def`` means this is a coroutine: you cannot simply call it
    and get a result, you have to ``await`` it (which the caller in
    [api.py](api.py) does inside its own ``async`` loop). Under the
    hood the ``await`` releases the event loop while Claude is
    thinking, so the rest of the server keeps serving requests.

    Args:
        snapshot: Dict-shaped health snapshot produced by the watchdog
            collector (``perception`` / ``drift`` / ``llm`` /
            ``pipeline`` / ``server`` sections). Serialised to JSON and
            handed to the model verbatim.
        prev_snapshot: The previous tick's snapshot, if any. Used only
            to compute per-key deltas (current vs previous vs diff)
            that help the LLM reason about trends instead of
            instantaneous values. ``None`` on the very first tick.

    Returns:
        Up to 3 :class:`WatchdogFinding` objects on success, each
        stamped ``source="ai"`` and ``cause_confidence="inferred"``.
        An empty list (``[]``) when:

        - the LLM stack is not importable (unit-test environments),
        - :func:`llm_configured` reports no provider is set up,
        - the model returns invalid JSON or a non-list value,
        - any other exception bubbles up.

        The 3-finding cap is deliberate — without it, a chatty model
        could drown the operator's incident queue in speculation.
    """
    # Lazy import so this module still imports cleanly when the LLM
    # stack is entirely absent (e.g. in unit tests).
    try:
        from backend.services.llm import _complete, llm_configured, MODEL_CHAT
    except ImportError:
        return []

    if not llm_configured():
        return []

    user_msg = "Current health snapshot:\n" + json.dumps(snapshot, indent=2, default=str)
    if prev_snapshot:
        deltas: dict[str, Any] = {}
        for key in ("pipeline", "perception", "llm"):
            curr = snapshot.get(key, {})
            prev = prev_snapshot.get(key, {})
            d = {}
            for k, v in curr.items():
                if isinstance(v, (int, float)) and k in prev:
                    diff = v - prev[k]
                    if diff != 0:
                        d[k] = {"current": v, "previous": prev[k], "delta": diff}
            if d:
                deltas[key] = d
        if deltas:
            user_msg += "\n\nChanges since last check:\n" + json.dumps(deltas, indent=2, default=str)

    try:
        raw, _inp, _out = await _complete(
            _ANALYSIS_SYSTEM, user_msg, MODEL_CHAT, max_tokens=1000,
            call_type="watchdog_analysis",
        )
        raw = raw.strip()
        # Defensive: strip markdown fencing if the model wrapped its
        # JSON in ```json blocks despite instructions.
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        items = json.loads(raw)
        if not isinstance(items, list):
            return []

        snap_id = uuid.uuid4().hex[:12]
        findings: list[WatchdogFinding] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            severity = str(item.get("severity", "info")).lower()
            # Refuse "info" AI findings — they tend to be commentary
            # rather than incidents and would crowd the queue.
            if severity not in {"error", "warning"}:
                continue
            findings.append(make_finding(
                severity=severity,
                category=str(item.get("category", "system")),
                title=str(item.get("title", "AI finding")),
                detail=str(item.get("detail", "")),
                suggestion=str(item.get("suggestion", "")),
                likely_cause=str(item.get("likely_cause", "")),
                snapshot_id=snap_id,
                source="ai",
                cause_confidence="inferred",
            ))
            if len(findings) >= 3:
                break
        return findings
    except Exception:
        # Monitoring-layer rule: any LLM failure is a no-op, never a
        # crash. Rule-based findings remain the source of truth.
        return []
