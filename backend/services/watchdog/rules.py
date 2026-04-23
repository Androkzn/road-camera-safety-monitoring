"""Deterministic rule-based watchdog detectors.

This module owns the rule-based detectors that scan the live system
"snapshot" (a plain dictionary of health numbers collected once per
tick) for known failure patterns — precision dropping, the LLM circuit
breaking, the video stream going dead, perception going blind, and so
on. Each detector that fires produces a ``WatchdogFinding`` object
(see [model.py](model.py)) via the ``make_finding`` factory.

This is the "always available" monitoring tier. The LLM-based
hypothesis layer in [ai.py](ai.py) is *additive* on top of this file:
it can suggest extra findings, but monitoring has to keep working even
when the LLM provider is down, rate-limited, or misconfigured. When
both tiers produce a finding with the same ``fingerprint``, the rule
wins because it is grounded in observed numbers rather than inferred
reasoning.

The entry point ``rule_checks`` is called on a timer from
[api.py](api.py) (the in-process ``Watchdog`` driver). The findings it
returns are persisted via [storage.py](storage.py) and then served to
the UI through the HTTP routes in
[backend/api/routers/watchdog.py](../../api/routers/watchdog.py).

Python idioms used in this file (quick primer for readers new to
Python):

- ``from __future__ import annotations`` — a special import that tells
  Python to treat all type hints (the ``: dict`` / ``-> list[...]``
  notes) as plain strings at runtime. This lets us use modern hint
  syntax on older interpreters without breaking anything.
- ``list[WatchdogFinding]`` — the generic/parameterised type syntax,
  meaning "a list whose items are ``WatchdogFinding`` objects".
- ``dict | None`` — the union operator on types, meaning "either a
  dict or the special value ``None``".
- ``snapshot.get("key", default)`` — read a value from a dictionary,
  returning ``default`` if the key is missing. Used defensively here
  so a partial snapshot never crashes a detector.
- *Early returns* / guard ``if`` blocks — each detector appends to the
  ``findings`` list only when its specific preconditions are met and
  otherwise falls through silently. This keeps every detector compact
  and independent.

UI connection
-------------
Page: MonitoringPage
([frontend/src/features/monitoring/MonitoringPage.tsx](../../../frontend/src/features/monitoring/MonitoringPage.tsx))

UI element: the rule-sourced ``IncidentCard`` tiles on MonitoringPage —
these are the findings whose ``source`` field is ``"rule"``. The
title, severity chip, evidence rows, and debug commands shown on each
card are all produced by one of the detectors in this file.

Backend route(s): indirect — findings reach the UI via
``GET /api/watchdog`` and the watchdog SSE (server-sent events) stream
wired up in
[backend/api/routers/watchdog.py](../../api/routers/watchdog.py).

Design notes
------------
These checks run on every tick and always produce ``source="rule"`` /
``cause_confidence="observed"`` findings. Monitoring must never depend
on LLM availability, so this module has no LLM imports — if the AI
layer ([ai.py](ai.py)) is unreachable, the queue still fires here.

The detectors are grouped in a fixed order (perception -> drift ->
LLM -> stream). Each gate targets a specific false-positive class;
tightening one gate with another is fine, but removing a gate to
"catch more" will produce alert noise.
"""

from __future__ import annotations

import uuid

from .model import WatchdogFinding, evidence, make_finding, top_bucket


def rule_checks(snapshot: dict, prev_snapshot: dict | None) -> list[WatchdogFinding]:
    """Run every rule-based detector against the current snapshot.

    This is the single public function of this module. The watchdog
    driver in [api.py](api.py) calls it on a timer, once per tick. The
    function steps through the detectors in a fixed order (perception,
    drift, LLM, stream) and appends a ``WatchdogFinding`` to the local
    ``findings`` list for every failure pattern that matches.

    What this function catches (each detector below corresponds to one
    card that can appear on the MonitoringPage UI):

    - *Camera / perception quality* — the perception subsystem reports
      ``degraded`` or ``failed``, or average detector confidence stays
      stubbornly low. Fires ``category="perception"`` findings, usually
      at ``warning`` but ``error`` when perception has fully failed.
    - *Drift and feedback loop* — the model's rolling precision is
      trending down, operators have stopped labeling events, the
      window has collapsed to zero duration, or false positives are
      arriving without any true positives. Fires ``category="drift"``
      findings, severities ``info`` -> ``warning`` -> ``error`` as the
      evidence strengthens.
    - *LLM reliability* — too many LLM calls are erroring, the
      provider has gotten slow (high p95 latency), or token counts
      look broken. Fires ``category="llm"`` findings; rate limiting
      (HTTP 429) is called out explicitly when detected.
    - *Stream throughput* — the stream reader thread has died, no
      frames moved during an interval, or the processed FPS is well
      below the configured target. Fires ``category="stream"``
      findings, usually ``error``.

    Operational symptoms that trigger these detectors include a
    darkened / blurry / obstructed camera feed, operators no longer
    giving feedback on recent events, a surge of provider 429 errors,
    the video URL becoming unreachable, or the host being too loaded
    to keep up with the configured frame rate.

    In plain English, the severity field on each finding means:

    - ``info`` — worth noting, does not require action.
    - ``warning`` — a trend the operator should look at soon.
    - ``error`` — a live incident; the system is probably producing
      incorrect or missing alerts right now.

    Args:
        snapshot: The most recent health snapshot produced by the
            caller-supplied ``collect_fn`` in the ``Watchdog`` driver.
            A snapshot is a nested dictionary with subsections for
            ``perception``, ``drift``, ``llm``, ``pipeline``,
            ``server``, and ``taxonomy``. See
            [backend/state.py](../../state.py) for where the
            underlying live state is defined.
        prev_snapshot: The snapshot from the previous tick, or
            ``None`` on the very first run. Several detectors skip
            themselves when this is absent because they need a delta
            (e.g. "no frames processed since last tick") that is
            undefined without a prior observation.

    Returns:
        A ``list`` of ``WatchdogFinding`` objects. The list is empty
        when everything is healthy. All findings produced in a single
        call share one ``snapshot_id`` so that grouping by that id
        tells you exactly which problems co-fired in the same tick.
    """
    findings: list[WatchdogFinding] = []
    snap_id = uuid.uuid4().hex[:12]

    # Unpack the subsystem sections defensively; every ``.get(k, {})``
    # guards against a partial snapshot so the detectors below never
    # index into ``None``.
    perc = snapshot.get("perception", {})
    drift = snapshot.get("drift", {})
    llm = snapshot.get("llm", {})
    pipeline = snapshot.get("pipeline", {})
    server = snapshot.get("server", {})
    taxonomy = snapshot.get("taxonomy", {})
    interval_sec = float(snapshot.get("_interval_sec", 60) or 60)

    frames_read = int(pipeline.get("frames_read", 0) or 0)
    frames_processed = int(pipeline.get("frames_processed", 0) or 0)
    target_fps = float(server.get("target_fps", 0) or 0)
    prev_frames_processed = int(prev_snapshot.get("pipeline", {}).get("frames_processed", 0) or 0) if prev_snapshot else 0
    processed_delta = frames_processed - prev_frames_processed

    # The reader is recreated whenever an operator stops/starts a slot.
    # The new StreamReader resets its frame counters to zero while the
    # process-level event buffer keeps accumulating, so per-tick deltas
    # can go strongly negative across a restart. Detect that here so
    # the throughput detectors below can skip this tick instead of
    # firing a false "stalled" alert.
    prev_uptime = float(prev_snapshot.get("server", {}).get("uptime_sec", 0) or 0) if prev_snapshot else 0.0
    current_uptime = float(server.get("uptime_sec", 0) or 0)
    reader_restarted = prev_snapshot is not None and (
        current_uptime + 1.0 < prev_uptime or processed_delta < 0
    )

    # 1. Camera / perception quality
    perc_state = perc.get("state", "nominal")
    perc_reason = perc.get("reason", "unknown")
    perc_conf = float(perc.get("avg_confidence", 0) or 0)
    perc_luma = float(perc.get("luminance", 0) or 0)
    perc_sharp = float(perc.get("sharpness", 0) or 0)
    perc_evidence = [
        evidence("Perception state", perc_state),
        evidence("Reason", perc_reason),
        evidence("Average confidence", f"{perc_conf:.2f}", threshold=">= 0.75", status="breach" if perc_conf < 0.75 else "context"),
        evidence("Luminance", f"{perc_luma:.0f}"),
        evidence("Sharpness", f"{perc_sharp:.0f}"),
    ]
    if perc_state == "degraded":
        findings.append(make_finding(
            severity="warning",
            category="perception",
            title="Camera perception degraded",
            detail=(
                f"Perception is degraded because `{perc_reason}` and confidence is only {perc_conf:.2f}. "
                f"This is high enough to keep running, but low enough to trust detections less."
            ),
            suggestion="Check the camera feed now and fix lighting, blur, or obstruction before tuning thresholds.",
            impact="Detection quality is no longer trustworthy enough for clean real-time triage, so you risk both misses and noisy alerts.",
            fingerprint="perception/degraded",
            evidence=perc_evidence,
            snapshot_id=snap_id,
        ))
    elif perc_state == "failed":
        findings.append(make_finding(
            severity="error",
            category="perception",
            title="Camera perception failed",
            detail=f"The perception monitor is in `failed` state because `{perc_reason}`.",
            suggestion="Restore the camera path first; every downstream signal depends on a usable image.",
            impact="The system is effectively blind, so conflict detection and any operator coaching based on it are compromised.",
            fingerprint="perception/failed",
            evidence=perc_evidence,
            snapshot_id=snap_id,
        ))
    # 10-sample floor keeps this from firing on transient first-frame noise.
    elif perc_conf < 0.70 and int(perc.get("samples", 0) or 0) >= 10:
        findings.append(make_finding(
            severity="info",
            category="perception",
            title="Average confidence remains low",
            detail=f"Average confidence is {perc_conf:.2f}, below the usual comfort floor even though the perception state is still nominal.",
            suggestion="Monitor the trend and inspect recent scenes before the issue turns into alert noise.",
            fingerprint="perception/confidence-low",
            evidence=perc_evidence,
            snapshot_id=snap_id,
        ))

    # 2. Drift / feedback loop health
    precision = float(drift.get("precision", 0) or 0)
    feedback_coverage = float(drift.get("feedback_coverage", 0) or 0)
    total_events = int(drift.get("total_events_in_window", 0) or 0)
    labeled_events = int(drift.get("labeled_events", 0) or 0)
    tp = int(drift.get("true_positives", 0) or 0)
    fp = int(drift.get("false_positives", 0) or 0)
    worst_type = top_bucket(drift.get("by_event_type", {}), prefer_low_precision=True)
    worst_type_text = ""
    if worst_type:
        worst_type_name, worst_type_stats = worst_type
        worst_precision = worst_type_stats.get("precision")
        if isinstance(worst_precision, (int, float)):
            worst_type_text = f"Worst event type is `{worst_type_name}` at {worst_precision:.2f} precision."
        else:
            worst_type_text = f"Worst event type appears to be `{worst_type_name}`, but it still has insufficient labels."

    drift_evidence = [
        evidence("Precision", f"{precision:.2f}", threshold=">= 0.70", status="breach" if precision < 0.70 else "context"),
        evidence("Feedback coverage", f"{feedback_coverage:.0%}", threshold="> 15%", status="breach" if feedback_coverage < 0.15 else "context"),
        evidence("Labels", labeled_events),
        evidence("Events in window", total_events),
        evidence("True positives", tp),
        evidence("False positives", fp),
    ]
    if worst_type_text:
        drift_evidence.append(evidence("Worst bucket", worst_type_text))

    if total_events >= 5 and feedback_coverage == 0:
        findings.append(make_finding(
            severity="error" if total_events >= 8 else "warning",
            category="drift",
            title=f"Zero feedback coverage across {total_events} events",
            detail=(
                f"No recent events were labeled by operators, so the drift report is blind. "
                f"Precision is being inferred from {labeled_events} labeled events out of {total_events}."
            ),
            suggestion="Restore the labeling path or operator feedback loop before trusting drift numbers.",
            impact="You can no longer tell whether false positives are rising, which makes model quality regressions much harder to catch early.",
            fingerprint="drift/feedback-coverage",
            evidence=drift_evidence,
            snapshot_id=snap_id,
        ))
    elif total_events >= 10 and feedback_coverage < 0.15:
        findings.append(make_finding(
            severity="warning",
            category="drift",
            title="Feedback coverage too thin for confidence",
            detail=f"Only {feedback_coverage:.0%} of the recent event window has operator labels.",
            suggestion="Increase verdict coverage before using this drift signal to justify threshold changes.",
            fingerprint="drift/feedback-coverage-thin",
            evidence=drift_evidence,
            snapshot_id=snap_id,
        ))

    # 3-label floor keeps this from firing on statistical noise at the
    # very start of a session.
    if drift.get("trend") == "degrading" and (tp + fp) >= 3:
        findings.append(make_finding(
            severity="warning",
            category="drift",
            title="Model precision trending down",
            detail=f"Rolling precision fell to {precision:.2f} with {tp} TP and {fp} FP in the current window. {worst_type_text}".strip(),
            suggestion="Review the newest false positives before changing thresholds globally.",
            fingerprint="drift/precision-degrading",
            evidence=drift_evidence,
            snapshot_id=snap_id,
        ))

    if drift.get("alert_triggered"):
        findings.append(make_finding(
            severity="error",
            category="drift",
            title="Drift alert triggered",
            detail=f"Precision is {precision:.2f}, below the alert threshold for a labeled window of {tp + fp} events. {worst_type_text}".strip(),
            suggestion="Treat this as an ML incident: review false positives, capture samples, and plan a threshold or model fix.",
            fingerprint="drift/precision-alert",
            evidence=drift_evidence,
            snapshot_id=snap_id,
        ))

    # Requires > 1 label: with a single label, start == end is tautological
    # (first and last operator_ts are the same entry), not a bookkeeping bug.
    if drift.get("window_start_ts") and drift.get("window_start_ts") == drift.get("window_end_ts") and (tp + fp) > 1:
        findings.append(make_finding(
            severity="warning",
            category="drift",
            title="Drift window collapsed to zero duration",
            detail=f"`window_start_ts` and `window_end_ts` are both `{drift.get('window_start_ts')}` even though the window contains {tp + fp} labeled events.",
            suggestion="Fix timestamp assignment before trusting trend calculations.",
            fingerprint="drift/window-collapsed",
            evidence=[
                evidence("Window start", drift.get("window_start_ts")),
                evidence("Window end", drift.get("window_end_ts")),
                evidence("Window labels", tp + fp),
            ],
            snapshot_id=snap_id,
        ))

    if fp > 0 and tp == 0 and (tp + fp) >= 1:
        findings.append(make_finding(
            severity="warning",
            category="drift",
            title="False positives with no true positives",
            detail=f"The current feedback window contains {fp} false positives and zero true positives. {worst_type_text}".strip(),
            suggestion="Review the flagged events now; this is often the fastest way to find a taxonomy or threshold bug.",
            fingerprint="drift/false-positive-spike",
            evidence=drift_evidence,
            snapshot_id=snap_id,
        ))

    recent_event_count = int(taxonomy.get("recent_events", 0) or 0)
    unknown_event_ratio = float(taxonomy.get("unknown_event_ratio", 0) or 0)
    unknown_risk_ratio = float(taxonomy.get("unknown_risk_ratio", 0) or 0)
    if recent_event_count >= 5 and max(unknown_event_ratio, unknown_risk_ratio) >= 0.5:
        findings.append(make_finding(
            severity="warning",
            category="drift",
            title="Recent events falling into unknown taxonomy",
            detail=(
                f"{taxonomy.get('unknown_event_types', 0)} of {recent_event_count} recent events have unknown event types and "
                f"{taxonomy.get('unknown_risk_levels', 0)} have unknown risk levels."
            ),
            suggestion="Fix event typing before tuning model thresholds, or you will hide the real failure mode.",
            fingerprint="drift/taxonomy-unknown",
            evidence=[
                evidence("Recent events", recent_event_count),
                evidence("Unknown event type ratio", f"{unknown_event_ratio:.0%}", threshold="< 20%", status="breach"),
                evidence("Unknown risk ratio", f"{unknown_risk_ratio:.0%}", threshold="< 20%", status="breach"),
            ],
            snapshot_id=snap_id,
        ))

    # 3. LLM reliability and instrumentation
    error_rate = float(llm.get("error_rate", 0) or 0)
    llm_calls = int(llm.get("window_calls", 0) or 0)
    top_errors = llm.get("top_errors", []) or []
    top_error = top_errors[0]["error"] if top_errors and isinstance(top_errors[0], dict) else ""
    by_type = llm.get("by_type", {}) or {}
    worst_call_type = ""
    worst_call_error_rate = -1.0
    for call_type, stats in by_type.items():
        calls = int(stats.get("calls", 0) or 0)
        if calls <= 0:
            continue
        call_error_rate = float(stats.get("errors", 0) or 0) / calls
        if call_error_rate > worst_call_error_rate:
            worst_call_type = call_type
            worst_call_error_rate = call_error_rate

    llm_evidence = [
        evidence("Window calls", llm_calls),
        evidence("Error rate", f"{error_rate:.1%}", threshold="<= 20%", status="breach" if error_rate > 0.2 else "context"),
        evidence("P50 latency", f"{float(llm.get('latency_p50_ms', 0) or 0):.0f} ms"),
        evidence("P95 latency", f"{float(llm.get('latency_p95_ms', 0) or 0):.0f} ms", threshold="< 10000 ms", status="breach" if float(llm.get("latency_p95_ms", 0) or 0) > 10000 else "context"),
    ]
    if worst_call_type:
        llm_evidence.append(evidence("Worst call type", f"{worst_call_type} ({worst_call_error_rate:.0%} errors)"))
    if top_error:
        llm_evidence.append(evidence("Top error", top_error))

    # 5-call floor is the minimum sample size before a percentage is
    # worth believing; 50%+ error promotes to ``error`` severity.
    if llm_calls >= 5 and error_rate > 0.2:
        likely_cause = "The dominant failure looks like provider rate limiting." if "429" in str(top_error) else ""
        findings.append(make_finding(
            severity="error" if error_rate >= 0.5 else "warning",
            category="llm",
            title=f"LLM error rate high ({error_rate:.0%})",
            detail=(
                f"{int(llm.get('total_errors_all_time', 0) or 0)} total LLM errors recorded; "
                f"{worst_call_type or 'overall traffic'} is the noisiest path in the current window."
            ),
            suggestion="Inspect recent LLM records and decide whether to reduce load, switch models, or rely on fallback temporarily.",
            likely_cause=likely_cause,
            fingerprint="llm/error-rate",
            evidence=llm_evidence,
            snapshot_id=snap_id,
        ))

    llm_p95 = float(llm.get("latency_p95_ms", 0) or 0)
    if llm_p95 > 10000:
        slowest_type = ""
        slowest_p95 = 0.0
        for call_type, stats in by_type.items():
            p95 = float(stats.get("latency_p95_ms", 0) or 0)
            if p95 > slowest_p95:
                slowest_p95 = p95
                slowest_type = call_type
        findings.append(make_finding(
            severity="error" if llm_p95 > 12000 else "warning",
            category="llm",
            title=f"LLM latency very high ({llm_p95:.0f}ms p95)",
            detail=f"P95 latency is {llm_p95:.0f}ms and the slowest call type is `{slowest_type or 'unknown'}` at {slowest_p95:.0f}ms.",
            suggestion="Keep safety-critical logic local and shift slow LLM work to a faster model or smaller prompt.",
            fingerprint="llm/latency",
            evidence=llm_evidence,
            snapshot_id=snap_id,
        ))

    prev_llm_p50 = float(prev_snapshot.get("llm", {}).get("latency_p50_ms", 0) or 0) if prev_snapshot else 0.0
    # 500ms floor on the previous value filters out noise at very low
    # latencies where small absolute swings look like big ratios.
    if prev_snapshot and prev_llm_p50 >= 500 and float(llm.get("latency_p50_ms", 0) or 0) > prev_llm_p50 * 1.5 and llm_calls >= 5:
        current_p50 = float(llm.get("latency_p50_ms", 0) or 0)
        findings.append(make_finding(
            severity="warning",
            category="llm",
            title="LLM median latency jumped sharply",
            detail=f"Median latency rose from {prev_llm_p50:.0f}ms to {current_p50:.0f}ms in one interval.",
            suggestion="Check whether load, prompt size, or provider congestion changed before the next interval compounds it.",
            fingerprint="llm/latency-jump",
            evidence=[
                evidence("Previous p50", f"{prev_llm_p50:.0f} ms"),
                evidence("Current p50", f"{current_p50:.0f} ms", status="trend"),
            ],
            snapshot_id=snap_id,
        ))

    # Per-call-type: instrumentation broken — latency recorded but
    # zero tokens either way.
    for call_type, stats in by_type.items():
        calls = int(stats.get("calls", 0) or 0)
        input_tokens = int(stats.get("input_tokens", 0) or 0)
        output_tokens = int(stats.get("output_tokens", 0) or 0)
        latency_p50 = float(stats.get("latency_p50_ms", 0) or 0)
        if calls >= 3 and latency_p50 > 0 and input_tokens == 0 and output_tokens == 0:
            findings.append(make_finding(
                severity="warning",
                category="llm",
                title=f"{call_type.capitalize()} calls reporting zero tokens",
                detail=f"{calls} `{call_type}` calls recorded latency but zero input/output tokens, which points to broken instrumentation or dropped responses.",
                suggestion="Inspect the raw LLM records for this call type before trusting cost or throughput numbers.",
                fingerprint=f"llm/token-instrumentation/{call_type}",
                evidence=[
                    evidence("Call type", call_type),
                    evidence("Calls", calls),
                    evidence("P50 latency", f"{latency_p50:.0f} ms"),
                    evidence("Input tokens", input_tokens),
                    evidence("Output tokens", output_tokens),
                ],
                snapshot_id=snap_id,
            ))

    # 4. Stream throughput and stalling
    if not server.get("running", True):
        findings.append(make_finding(
            severity="error",
            category="stream",
            title="Stream reader not running",
            detail="The stream reader thread is no longer alive, so the pipeline is not ingesting new frames.",
            suggestion="Verify the source URL and restart the reader after network and source health are confirmed.",
            fingerprint="stream/stopped",
            evidence=[evidence("Reader running", False)],
            snapshot_id=snap_id,
        ))

    # 10s minimum interval distinguishes "stalled" from "slow".
    # Skip across reader restarts: the new reader's counters start at
    # zero, which would otherwise look identical to a stall.
    if (
        prev_snapshot
        and not reader_restarted
        and server.get("running", True)
        and processed_delta <= 0
        and interval_sec >= 10
    ):
        findings.append(make_finding(
            severity="error",
            category="stream",
            title="Frame processing appears stalled",
            detail=f"No new frames were processed in the last {interval_sec:.0f}s while the reader still reports itself as running.",
            suggestion="Treat this like a live-ingest incident: inspect the source, buffering, and host resource pressure now.",
            fingerprint="stream/stalled",
            evidence=[
                evidence("Frames processed delta", processed_delta),
                evidence("Interval", f"{interval_sec:.0f}s"),
                evidence("Reader running", server.get("running", True)),
            ],
            snapshot_id=snap_id,
        ))

    # NOTE: a "frame drop rate" detector that compared frames_processed to
    # frames_read used to live here. It fired constantly because StreamReader
    # subsamples by design — at TARGET_FPS=2 over a 30fps source it pulls
    # every frame but only forwards every 15th one to the perception loop,
    # so the "drop rate" sits at ~93% during healthy operation. The actual
    # concern (effective fps falling below target) is covered by the
    # detector below, which compares processed_delta to target_fps directly.

    # 200-frame floor ensures the pipeline is warmed up before evaluation.
    if (
        prev_snapshot
        and not reader_restarted
        and target_fps > 0
        and interval_sec > 0
        and frames_read > 200
    ):
        actual_fps = processed_delta / interval_sec if processed_delta >= 0 else 0.0
        if actual_fps < target_fps * 0.5:
            findings.append(make_finding(
                severity="warning",
                category="stream",
                title=f"Actual FPS ({actual_fps:.1f}) well below target",
                detail=f"The pipeline processed {processed_delta} frames in {interval_sec:.0f}s, or {actual_fps:.1f} fps versus a target of {target_fps:.1f}.",
                suggestion="Check buffering and host load before trusting real-time alerting performance.",
                fingerprint="stream/fps-low",
                evidence=[
                    evidence("Actual FPS", f"{actual_fps:.1f}", threshold=f">= {target_fps:.1f}", status="breach"),
                    evidence("Target FPS", f"{target_fps:.1f}"),
                ],
                snapshot_id=snap_id,
            ))

    return findings
