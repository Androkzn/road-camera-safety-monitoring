"""watchdog.py — always-on self-monitor that flags system health issues.

What it does:
    Every 60 seconds (by default) the watchdog grabs a "snapshot" of how
    the whole system is doing — camera quality, model accuracy drift,
    LLM error rates, stream frame-rate, etc. — then runs a set of plain
    rule checks ("error rate above 20%?", "frames stuck?") and writes
    every problem it finds as a "finding" to a log file. It can
    optionally ask Claude to look at the same snapshot for anomalies the
    rules missed.

Purpose:
    Operators should learn about problems from the dashboard, not from
    users. The watchdog is the system's built-in smoke detector: it
    writes human-readable findings with owner, impact, suggested steps,
    and debug commands so on-call engineers know exactly where to look.

How it works:
    * Findings are stored in ``data/watchdog.jsonl`` — one JSON record
      per line, append-only (easy to tail, hard to corrupt).
    * ``@dataclass`` on ``WatchdogFinding`` is a Python shortcut that
      auto-generates an ``__init__`` and field list from the type
      annotations — it is just a typed struct.
    * ``async def check_once`` runs one snapshot+analysis cycle;
      ``run_loop`` keeps calling it forever with a sleep between runs.
      ``async``/``await`` means the loop cooperates with the web server
      on the same thread instead of blocking it.
    * If the LLM is down, rule checks still run — monitoring never
      depends on Claude being available.
    * Findings with the same "fingerprint" are grouped so the dashboard
      shows "this problem happened 12 times" instead of 12 separate rows.

Connects to:
    - Backend: ``road_safety/server.py`` constructs a ``Watchdog`` with
      a ``collect_fn`` that builds the snapshot, and exposes
      ``/api/watchdog``, ``/api/watchdog/recent``, and
      ``/api/watchdog/findings`` (DELETE/POST).
    - UI: ``frontend/src/hooks/useWatchdog.ts`` and
      ``frontend/src/hooks/WatchdogContext.tsx`` poll these endpoints;
      ``frontend/src/components/watchdog/WatchdogDrawer.tsx`` and
      ``WatchdogBadge.tsx`` render the findings in the TopBar drawer.
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from road_safety.config import DATA_DIR

_WATCHDOG_PATH = DATA_DIR / "watchdog.jsonl"
_MAX_TAIL = 200
_lock = threading.Lock()

_SEVERITY_ORDER = {"error": 3, "warning": 2, "info": 1}
_OWNER_BY_CATEGORY = {
    "perception": "Edge camera ops",
    "drift": "ML quality",
    "llm": "AI platform",
    "stream": "Video ingest",
    "scene": "Scene understanding",
    "system": "Platform",
}
_RUNBOOK_BY_CATEGORY = {
    "perception": "Verify live camera quality, lens obstruction, lighting, and mount stability.",
    "drift": "Review recent false positives, validate labeling coverage, and plan threshold or model updates.",
    "llm": "Inspect provider health, rate limiting, fallback behavior, and token instrumentation.",
    "stream": "Check stream source health, frame throughput, and local resource pressure.",
    "scene": "Validate scene classifier inputs and thresholds against current roadway conditions.",
    "system": "Inspect recent deploys, runtime logs, and subsystem health endpoints.",
}
_DEFAULT_IMPACT_BY_CATEGORY = {
    "perception": "Perception quality is degraded, so real conflicts may be missed and noisy alerts may increase.",
    "drift": "Operators may lose trust because alert precision is degrading or becoming unmeasurable.",
    "llm": "Narration, enrichment, and investigation workflows will become slower, noisier, or unavailable.",
    "stream": "Live detection coverage is reduced because frames are not moving through the pipeline reliably.",
    "scene": "Context-aware thresholds may become unreliable, increasing false positives or missed conflicts.",
    "system": "The dashboard may report misleading health information until the underlying issue is fixed.",
}


def _slugify(text: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return text or "finding"


def _severity_rank(severity: str) -> int:
    return _SEVERITY_ORDER.get((severity or "").lower(), 0)


def _priority_score(severity: str, source: str, evidence_count: int) -> int:
    base = {"error": 90, "warning": 60, "info": 30}.get((severity or "").lower(), 10)
    if source == "rule":
        base += 5
    return base + min(max(evidence_count, 0), 5) * 2


def _evidence(label: str, value: Any, *, threshold: str | None = None, status: str = "observed") -> dict[str, str]:
    item = {"label": label, "value": str(value)}
    if threshold:
        item["threshold"] = threshold
    if status != "observed":
        item["status"] = status
    return item


def _top_bucket(buckets: dict[str, Any], *, prefer_low_precision: bool = False) -> tuple[str, dict[str, Any]] | None:
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


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _fingerprint_for(category: str, title: str) -> str:
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


def _defaults_for(category: str, title: str, severity: str) -> dict[str, Any]:
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
            "curl -H \"Authorization: Bearer $ROAD_ADMIN_TOKEN\" http://localhost:8000/api/llm/stats",
            "curl -H \"Authorization: Bearer $ROAD_ADMIN_TOKEN\" http://localhost:8000/api/llm/recent",
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
            "curl -H \"Authorization: Bearer $ROAD_ADMIN_TOKEN\" http://localhost:8000/api/llm/stats",
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
            "curl -H \"Authorization: Bearer $ROAD_ADMIN_TOKEN\" http://localhost:8000/api/llm/stats",
            "curl -H \"Authorization: Bearer $ROAD_ADMIN_TOKEN\" http://localhost:8000/api/llm/recent",
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
        "fingerprint": _fingerprint_for(cat, title),
        "priority_score": _priority_score(severity, "rule", evidence_count=0),
    }


def _normalize_finding_payload(payload: dict[str, Any]) -> dict[str, Any]:
    severity = (payload.get("severity") or "info").lower()
    category = payload.get("category") or "system"
    title = payload.get("title") or "Watchdog finding"
    detail = payload.get("detail") or ""
    defaults = _defaults_for(category, title, severity)

    evidence = [
        {k: str(v) for k, v in item.items()}
        for item in (payload.get("evidence") or [])
        if isinstance(item, dict) and item.get("label") and item.get("value") is not None
    ]
    source = payload.get("source") or "rule"
    priority = payload.get("priority_score")
    if not isinstance(priority, int):
        priority = _priority_score(severity, source, len(evidence))

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
        "cause_confidence": payload.get("cause_confidence") or ("inferred" if source == "ai" else "observed"),
        "priority_score": priority,
        "evidence": evidence,
        "investigation_steps": payload.get("investigation_steps") or defaults["investigation_steps"],
        "debug_commands": payload.get("debug_commands") or defaults["debug_commands"],
        "ts": payload.get("ts") or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "snapshot_id": payload.get("snapshot_id") or uuid.uuid4().hex[:12],
    }


def _normalize_finding(finding: WatchdogFinding) -> WatchdogFinding:
    payload = _normalize_finding_payload(finding.as_dict())
    return WatchdogFinding(**payload)


def _group_findings(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for record in records:
        item = _normalize_finding_payload(record)
        key = item["fingerprint"]
        group = groups.get(key)
        ts = _parse_ts(item["ts"])
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
        if _severity_rank(item["severity"]) > _severity_rank(group["severity"]):
            group["severity"] = item["severity"]
        first_seen_dt = _parse_ts(group["first_seen_ts"])
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


@dataclass
class WatchdogFinding:
    severity: str          # "error" | "warning" | "info"
    category: str          # "perception" | "drift" | "llm" | "stream" | "scene" | "system"
    title: str
    detail: str
    suggestion: str = ""
    impact: str = ""
    likely_cause: str = ""
    owner: str = ""
    runbook: str = ""
    fingerprint: str = ""
    source: str = "rule"   # "rule" | "ai"
    cause_confidence: str = "observed"  # "observed" | "inferred"
    priority_score: int = 0
    evidence: list[dict[str, str]] = field(default_factory=list)
    investigation_steps: list[str] = field(default_factory=list)
    debug_commands: list[str] = field(default_factory=list)
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    snapshot_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def as_dict(self) -> dict:
        return asdict(self)


def _write_finding(finding: WatchdogFinding) -> None:
    try:
        finding = _normalize_finding(finding)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _lock:
            with _WATCHDOG_PATH.open("a", encoding="utf-8") as f:
                f.write(json.dumps(finding.as_dict(), ensure_ascii=False, default=str) + "\n")
    except OSError:
        pass


def tail(n: int = _MAX_TAIL) -> list[dict]:
    """Return the most recent N watchdog findings."""
    if not _WATCHDOG_PATH.exists():
        return []
    try:
        lines = _WATCHDOG_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for raw in lines[-n:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            out.append(_normalize_finding_payload(json.loads(raw)))
        except json.JSONDecodeError:
            continue
    return out


def delete_findings(indices: list[int] | None = None) -> int:
    """Delete findings by line index (0-based) or all if indices is None.

    Returns the number of deleted findings.
    """
    if not _WATCHDOG_PATH.exists():
        return 0
    with _lock:
        try:
            lines = _WATCHDOG_PATH.read_text(encoding="utf-8").splitlines()
        except OSError:
            return 0
        if indices is None:
            count = len(lines)
            _WATCHDOG_PATH.write_text("", encoding="utf-8")
            return count
        to_remove = set(indices)
        kept = [line for i, line in enumerate(lines) if i not in to_remove]
        removed = len(lines) - len(kept)
        _WATCHDOG_PATH.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        return removed


def delete_findings_by_id(snapshot_ids: list[str]) -> int:
    """Delete findings matching any of the given snapshot_id+ts combos."""
    if not _WATCHDOG_PATH.exists():
        return 0
    ids_set = set(snapshot_ids)
    with _lock:
        try:
            lines = _WATCHDOG_PATH.read_text(encoding="utf-8").splitlines()
        except OSError:
            return 0
        kept: list[str] = []
        removed = 0
        for line in lines:
            raw = line.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
                key = f"{obj.get('snapshot_id', '')}_{obj.get('ts', '')}"
                if key in ids_set:
                    removed += 1
                    continue
            except json.JSONDecodeError:
                pass
            kept.append(line)
        _WATCHDOG_PATH.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        return removed


def stats() -> dict:
    """Summary counts for the dashboard."""
    records = tail(500)
    by_severity: dict[str, int] = {}
    by_category: dict[str, int] = {}
    incidents = _group_findings(records)
    for incident in incidents:
        sev = incident.get("severity", "unknown")
        by_severity[sev] = by_severity.get(sev, 0) + 1
        cat = incident.get("category", "unknown")
        by_category[cat] = by_category.get(cat, 0) + 1
    top_incidents = sorted(
        incidents,
        key=lambda i: (
            -_severity_rank(str(i.get("severity", "info"))),
            -int(i.get("count", 0)),
            str(i.get("last_seen_ts", "")),
        ),
    )[:5]
    return {
        "total_findings": len(records),
        "unique_incidents": len(incidents),
        "repeating_incidents": sum(1 for i in incidents if int(i.get("count", 0)) > 1),
        "by_severity": by_severity,
        "by_category": by_category,
        "top_incidents": top_incidents,
    }


# ── Rule-based checks (always available, no LLM needed) ──────────────

def _make_finding(
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
    defaults = _defaults_for(category, title, severity)
    evidence_items = evidence or []
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
        priority_score=_priority_score(severity, source, len(evidence_items)),
        evidence=evidence_items,
        investigation_steps=investigation_steps or defaults["investigation_steps"],
        debug_commands=debug_commands or defaults["debug_commands"],
        snapshot_id=snapshot_id,
    )


def _rule_checks(snapshot: dict, prev_snapshot: dict | None) -> list[WatchdogFinding]:
    findings: list[WatchdogFinding] = []
    snap_id = uuid.uuid4().hex[:12]

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

    # 1. Camera / perception quality
    perc_state = perc.get("state", "nominal")
    perc_reason = perc.get("reason", "unknown")
    perc_conf = float(perc.get("avg_confidence", 0) or 0)
    perc_luma = float(perc.get("luminance", 0) or 0)
    perc_sharp = float(perc.get("sharpness", 0) or 0)
    perc_evidence = [
        _evidence("Perception state", perc_state),
        _evidence("Reason", perc_reason),
        _evidence("Average confidence", f"{perc_conf:.2f}", threshold=">= 0.75", status="breach" if perc_conf < 0.75 else "context"),
        _evidence("Luminance", f"{perc_luma:.0f}"),
        _evidence("Sharpness", f"{perc_sharp:.0f}"),
    ]
    if perc_state == "degraded":
        findings.append(_make_finding(
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
        findings.append(_make_finding(
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
    elif perc_conf < 0.70 and int(perc.get("samples", 0) or 0) >= 10:
        findings.append(_make_finding(
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
    worst_type = _top_bucket(drift.get("by_event_type", {}), prefer_low_precision=True)
    worst_type_text = ""
    if worst_type:
        worst_type_name, worst_type_stats = worst_type
        worst_precision = worst_type_stats.get("precision")
        if isinstance(worst_precision, (int, float)):
            worst_type_text = f"Worst event type is `{worst_type_name}` at {worst_precision:.2f} precision."
        else:
            worst_type_text = f"Worst event type appears to be `{worst_type_name}`, but it still has insufficient labels."

    drift_evidence = [
        _evidence("Precision", f"{precision:.2f}", threshold=">= 0.70", status="breach" if precision < 0.70 else "context"),
        _evidence("Feedback coverage", f"{feedback_coverage:.0%}", threshold="> 15%", status="breach" if feedback_coverage < 0.15 else "context"),
        _evidence("Labels", labeled_events),
        _evidence("Events in window", total_events),
        _evidence("True positives", tp),
        _evidence("False positives", fp),
    ]
    if worst_type_text:
        drift_evidence.append(_evidence("Worst bucket", worst_type_text))

    if total_events >= 5 and feedback_coverage == 0:
        findings.append(_make_finding(
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
        findings.append(_make_finding(
            severity="warning",
            category="drift",
            title="Feedback coverage too thin for confidence",
            detail=f"Only {feedback_coverage:.0%} of the recent event window has operator labels.",
            suggestion="Increase verdict coverage before using this drift signal to justify threshold changes.",
            fingerprint="drift/feedback-coverage-thin",
            evidence=drift_evidence,
            snapshot_id=snap_id,
        ))

    if drift.get("trend") == "degrading" and (tp + fp) >= 3:
        findings.append(_make_finding(
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
        findings.append(_make_finding(
            severity="error",
            category="drift",
            title="Drift alert triggered",
            detail=f"Precision is {precision:.2f}, below the alert threshold for a labeled window of {tp + fp} events. {worst_type_text}".strip(),
            suggestion="Treat this as an ML incident: review false positives, capture samples, and plan a threshold or model fix.",
            fingerprint="drift/precision-alert",
            evidence=drift_evidence,
            snapshot_id=snap_id,
        ))

    if drift.get("window_start_ts") and drift.get("window_start_ts") == drift.get("window_end_ts") and (tp + fp) > 0:
        findings.append(_make_finding(
            severity="warning",
            category="drift",
            title="Drift window collapsed to zero duration",
            detail=f"`window_start_ts` and `window_end_ts` are both `{drift.get('window_start_ts')}` even though the window contains {tp + fp} labeled events.",
            suggestion="Fix timestamp assignment before trusting trend calculations.",
            fingerprint="drift/window-collapsed",
            evidence=[
                _evidence("Window start", drift.get("window_start_ts")),
                _evidence("Window end", drift.get("window_end_ts")),
                _evidence("Window labels", tp + fp),
            ],
            snapshot_id=snap_id,
        ))

    if fp > 0 and tp == 0 and (tp + fp) >= 1:
        findings.append(_make_finding(
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
        findings.append(_make_finding(
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
                _evidence("Recent events", recent_event_count),
                _evidence("Unknown event type ratio", f"{unknown_event_ratio:.0%}", threshold="< 20%", status="breach"),
                _evidence("Unknown risk ratio", f"{unknown_risk_ratio:.0%}", threshold="< 20%", status="breach"),
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
        _evidence("Window calls", llm_calls),
        _evidence("Error rate", f"{error_rate:.1%}", threshold="<= 20%", status="breach" if error_rate > 0.2 else "context"),
        _evidence("P50 latency", f"{float(llm.get('latency_p50_ms', 0) or 0):.0f} ms"),
        _evidence("P95 latency", f"{float(llm.get('latency_p95_ms', 0) or 0):.0f} ms", threshold="< 10000 ms", status="breach" if float(llm.get("latency_p95_ms", 0) or 0) > 10000 else "context"),
    ]
    if worst_call_type:
        llm_evidence.append(_evidence("Worst call type", f"{worst_call_type} ({worst_call_error_rate:.0%} errors)"))
    if top_error:
        llm_evidence.append(_evidence("Top error", top_error))

    if llm_calls >= 5 and error_rate > 0.2:
        likely_cause = "The dominant failure looks like provider rate limiting." if "429" in str(top_error) else ""
        findings.append(_make_finding(
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
        findings.append(_make_finding(
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
    if prev_snapshot and prev_llm_p50 >= 500 and float(llm.get("latency_p50_ms", 0) or 0) > prev_llm_p50 * 1.5 and llm_calls >= 5:
        current_p50 = float(llm.get("latency_p50_ms", 0) or 0)
        findings.append(_make_finding(
            severity="warning",
            category="llm",
            title="LLM median latency jumped sharply",
            detail=f"Median latency rose from {prev_llm_p50:.0f}ms to {current_p50:.0f}ms in one interval.",
            suggestion="Check whether load, prompt size, or provider congestion changed before the next interval compounds it.",
            fingerprint="llm/latency-jump",
            evidence=[
                _evidence("Previous p50", f"{prev_llm_p50:.0f} ms"),
                _evidence("Current p50", f"{current_p50:.0f} ms", status="trend"),
            ],
            snapshot_id=snap_id,
        ))

    for call_type, stats in by_type.items():
        calls = int(stats.get("calls", 0) or 0)
        input_tokens = int(stats.get("input_tokens", 0) or 0)
        output_tokens = int(stats.get("output_tokens", 0) or 0)
        latency_p50 = float(stats.get("latency_p50_ms", 0) or 0)
        if calls >= 3 and latency_p50 > 0 and input_tokens == 0 and output_tokens == 0:
            findings.append(_make_finding(
                severity="warning",
                category="llm",
                title=f"{call_type.capitalize()} calls reporting zero tokens",
                detail=f"{calls} `{call_type}` calls recorded latency but zero input/output tokens, which points to broken instrumentation or dropped responses.",
                suggestion="Inspect the raw LLM records for this call type before trusting cost or throughput numbers.",
                fingerprint=f"llm/token-instrumentation/{call_type}",
                evidence=[
                    _evidence("Call type", call_type),
                    _evidence("Calls", calls),
                    _evidence("P50 latency", f"{latency_p50:.0f} ms"),
                    _evidence("Input tokens", input_tokens),
                    _evidence("Output tokens", output_tokens),
                ],
                snapshot_id=snap_id,
            ))

    # 4. Stream throughput and stalling
    if not server.get("running", True):
        findings.append(_make_finding(
            severity="error",
            category="stream",
            title="Stream reader not running",
            detail="The stream reader thread is no longer alive, so the pipeline is not ingesting new frames.",
            suggestion="Verify the source URL and restart the reader after network and source health are confirmed.",
            fingerprint="stream/stopped",
            evidence=[_evidence("Reader running", False)],
            snapshot_id=snap_id,
        ))

    if prev_snapshot and server.get("running", True) and processed_delta <= 0 and interval_sec >= 10:
        findings.append(_make_finding(
            severity="error",
            category="stream",
            title="Frame processing appears stalled",
            detail=f"No new frames were processed in the last {interval_sec:.0f}s while the reader still reports itself as running.",
            suggestion="Treat this like a live-ingest incident: inspect the source, buffering, and host resource pressure now.",
            fingerprint="stream/stalled",
            evidence=[
                _evidence("Frames processed delta", processed_delta),
                _evidence("Interval", f"{interval_sec:.0f}s"),
                _evidence("Reader running", server.get("running", True)),
            ],
            snapshot_id=snap_id,
        ))

    if frames_read > 100:
        drop_rate = 1.0 - (frames_processed / frames_read) if frames_read > 0 else 0.0
        if drop_rate > 0.1:
            findings.append(_make_finding(
                severity="error" if drop_rate > 0.25 else "warning",
                category="stream",
                title=f"Frame drop rate elevated ({drop_rate:.0%})",
                detail=f"The pipeline has read {frames_read} frames but processed only {frames_processed}, leaving a {drop_rate:.1%} drop rate.",
                suggestion="Inspect CPU and memory pressure before lowering FPS or model load.",
                fingerprint="stream/frame-drop",
                evidence=[
                    _evidence("Frames read", frames_read),
                    _evidence("Frames processed", frames_processed),
                    _evidence("Drop rate", f"{drop_rate:.1%}", threshold="<= 10%", status="breach"),
                ],
                snapshot_id=snap_id,
            ))

    if prev_snapshot and target_fps > 0 and interval_sec > 0 and frames_read > 200:
        actual_fps = processed_delta / interval_sec if processed_delta >= 0 else 0.0
        if actual_fps < target_fps * 0.5:
            findings.append(_make_finding(
                severity="warning",
                category="stream",
                title=f"Actual FPS ({actual_fps:.1f}) well below target",
                detail=f"The pipeline processed {processed_delta} frames in {interval_sec:.0f}s, or {actual_fps:.1f} fps versus a target of {target_fps:.1f}.",
                suggestion="Check buffering and host load before trusting real-time alerting performance.",
                fingerprint="stream/fps-low",
                evidence=[
                    _evidence("Actual FPS", f"{actual_fps:.1f}", threshold=f">= {target_fps:.1f}", status="breach"),
                    _evidence("Target FPS", f"{target_fps:.1f}"),
                ],
                snapshot_id=snap_id,
            ))

    return findings


# ── AI analysis (Claude) ─────────────────────────────────────────────

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
    "Be concise — title under 10 words, detail under 50 words, suggestion under 30 words."
)


async def _ai_analyze(snapshot: dict, prev_snapshot: dict | None) -> list[WatchdogFinding]:
    """Send snapshot to Claude for AI analysis. Returns findings or [] on failure."""
    try:
        from road_safety.services.llm import _complete, llm_configured, MODEL_CHAT
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
        raw = await _complete(_ANALYSIS_SYSTEM, user_msg, MODEL_CHAT, max_tokens=1000)
        raw = raw.strip()
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
            if severity not in {"error", "warning"}:
                continue
            findings.append(_make_finding(
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
        return []


# ── Main Watchdog class ──────────────────────────────────────────────

class Watchdog:
    """Background monitor that periodically checks system health."""

    def __init__(
        self,
        collect_fn: Callable[[], dict],
        interval_sec: int = 60,
    ):
        self._collect = collect_fn
        self._interval = interval_sec
        self._prev_snapshot: dict | None = None
        self._last_run: float = 0
        self._run_count: int = 0
        self._total_findings: int = 0

    def status(self) -> dict:
        return {
            "enabled": True,
            "interval_sec": self._interval,
            "last_run": self._last_run,
            "last_run_ago_sec": round(time.time() - self._last_run, 1) if self._last_run else None,
            "run_count": self._run_count,
            "total_findings_emitted": self._total_findings,
            **stats(),
        }

    async def check_once(self) -> list[WatchdogFinding]:
        """Run one check cycle: collect snapshot, analyze, store findings."""
        snapshot = self._collect()
        snapshot["_interval_sec"] = self._interval

        # Rule-based checks (always run)
        findings = _rule_checks(snapshot, self._prev_snapshot)

        # AI analysis (best-effort)
        ai_findings = await _ai_analyze(snapshot, self._prev_snapshot)
        # Deduplicate: prefer rule findings when both describe the same incident.
        rule_fingerprints = {f.fingerprint for f in findings}
        rule_titles = {f.title for f in findings}
        for af in ai_findings:
            if af.fingerprint not in rule_fingerprints and af.title not in rule_titles:
                findings.append(af)

        for f in findings:
            _write_finding(f)

        self._prev_snapshot = snapshot
        self._last_run = time.time()
        self._run_count += 1
        self._total_findings += len(findings)

        return findings

    async def run_loop(self) -> None:
        """Long-running background loop. Call as ``asyncio.create_task(wd.run_loop())``."""
        await asyncio.sleep(15)
        while True:
            try:
                await self.check_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(self._interval)
