"""AI hypothesis layer: strictly additive Claude-powered analyzer.

When the LLM stack is unconfigured, unreachable, or returns garbage,
this layer produces zero findings and the rule-based layer
([rules.py](rules.py)) carries on alone. Every finding produced here is
labeled ``source="ai"`` and ``cause_confidence="inferred"`` so the UI
can style hypotheses distinctly from deterministic observations.

The LLM call is routed through ``services/llm.py`` so this module
inherits the project's failover, rate budget, circuit breaker, and
cost tracking — do not bypass it with a direct provider call.
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
    """Ask Claude to hypothesize incidents from a snapshot; best-effort.

    Args:
        snapshot: Current health snapshot.
        prev_snapshot: Previous tick's snapshot, if any. Used only to
            compute per-key deltas that help the LLM reason about
            trends.

    Returns:
        Up to 3 WatchdogFinding objects on success; an empty list when
        the LLM stack is unconfigured, unreachable, returns invalid
        JSON, or any other error occurs. Findings are capped at 3 so
        the incident queue never drowns in AI speculation.
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
