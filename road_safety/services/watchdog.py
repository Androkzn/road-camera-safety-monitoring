"""AI-powered background watchdog — monitors all subsystems for issues.

Runs a periodic loop (default 60s) that collects a health snapshot from
every subsystem (perception, drift, LLM, stream, scene), applies rule-based
checks, and optionally sends the snapshot to Claude for deeper analysis.

Findings are appended to ``data/watchdog.jsonl`` (same append-only JSONL
pattern as audit). The ``/api/watchdog`` endpoint exposes summary stats;
``/api/watchdog/recent`` returns the most recent findings for investigation.

If the LLM is unavailable the watchdog still produces findings from rule-based
checks — monitoring never depends on LLM availability.
"""

from __future__ import annotations

import asyncio
import json
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


@dataclass
class WatchdogFinding:
    severity: str          # "error" | "warning" | "info"
    category: str          # "perception" | "drift" | "llm" | "stream" | "scene" | "system"
    title: str
    detail: str
    suggestion: str = ""
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    snapshot_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def as_dict(self) -> dict:
        return asdict(self)


def _write_finding(finding: WatchdogFinding) -> None:
    try:
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
            out.append(json.loads(raw))
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
    for r in records:
        sev = r.get("severity", "unknown")
        by_severity[sev] = by_severity.get(sev, 0) + 1
        cat = r.get("category", "unknown")
        by_category[cat] = by_category.get(cat, 0) + 1
    return {
        "total_findings": len(records),
        "by_severity": by_severity,
        "by_category": by_category,
    }


# ── Rule-based checks (always available, no LLM needed) ──────────────

def _rule_checks(snapshot: dict, prev_snapshot: dict | None) -> list[WatchdogFinding]:
    findings: list[WatchdogFinding] = []
    snap_id = uuid.uuid4().hex[:12]

    # 1. Perception degraded or failed
    perc = snapshot.get("perception", {})
    perc_state = perc.get("state", "nominal")
    if perc_state == "degraded":
        findings.append(WatchdogFinding(
            severity="warning", category="perception",
            title="Camera perception degraded",
            detail=f"Perception state: {perc_state}. Reason: {perc.get('reason', 'unknown')}. "
                   f"Avg confidence: {perc.get('avg_confidence', 0):.2f}, luminance: {perc.get('luminance', 0):.0f}",
            suggestion="Check camera lens, lighting conditions, or mounting angle.",
            snapshot_id=snap_id,
        ))
    elif perc_state == "failed":
        findings.append(WatchdogFinding(
            severity="error", category="perception",
            title="Camera perception failed",
            detail=f"Perception in failed state. Reason: {perc.get('reason', 'unknown')}",
            suggestion="Camera may be obstructed or offline. Immediate inspection needed.",
            snapshot_id=snap_id,
        ))

    # 2. Drift trending down
    drift = snapshot.get("drift", {})
    if drift.get("trend") == "degrading":
        prec = drift.get("precision", 0)
        findings.append(WatchdogFinding(
            severity="warning", category="drift",
            title="Model precision trending down",
            detail=f"Drift trend: degrading. Current precision: {prec:.2f}. "
                   f"TP={drift.get('true_positives', 0)}, FP={drift.get('false_positives', 0)}",
            suggestion="Review recent false-positive events. Consider retraining or threshold adjustment.",
            snapshot_id=snap_id,
        ))
    if drift.get("alert_triggered"):
        findings.append(WatchdogFinding(
            severity="error", category="drift",
            title="Drift alert triggered",
            detail=f"Precision dropped below threshold. Current: {drift.get('precision', 0):.2f}",
            suggestion="Urgent: collect active-learning samples and schedule model retraining.",
            snapshot_id=snap_id,
        ))

    # 3. LLM error rate
    llm = snapshot.get("llm", {})
    error_rate = llm.get("error_rate", 0)
    if error_rate > 0.2:
        findings.append(WatchdogFinding(
            severity="warning" if error_rate < 0.5 else "error",
            category="llm",
            title=f"LLM error rate high ({error_rate:.0%})",
            detail=f"Error rate: {error_rate:.1%}. Total errors: {llm.get('total_errors_all_time', 0)}. "
                   f"Window calls: {llm.get('window_calls', 0)}",
            suggestion="Check API key validity, rate limits, and provider status page.",
            snapshot_id=snap_id,
        ))

    # 4. Frame drop rate
    pipeline = snapshot.get("pipeline", {})
    frames_read = pipeline.get("frames_read", 0)
    frames_processed = pipeline.get("frames_processed", 0)
    if frames_read > 100:
        drop_rate = 1.0 - (frames_processed / frames_read) if frames_read > 0 else 0
        if drop_rate > 0.1:
            findings.append(WatchdogFinding(
                severity="warning", category="stream",
                title=f"Frame drop rate elevated ({drop_rate:.0%})",
                detail=f"Read: {frames_read}, processed: {frames_processed}, drop rate: {drop_rate:.1%}",
                suggestion="System may be under CPU/memory pressure. Consider reducing TARGET_FPS.",
                snapshot_id=snap_id,
            ))

    # 5. Stream not running
    server = snapshot.get("server", {})
    if not server.get("running", True):
        findings.append(WatchdogFinding(
            severity="error", category="stream",
            title="Stream reader not running",
            detail="The video stream reader thread has stopped.",
            suggestion="Check stream source URL and network connectivity. Restart may be needed.",
            snapshot_id=snap_id,
        ))

    # 6. FPS drop vs target
    if prev_snapshot and frames_read > 200:
        prev_frames = prev_snapshot.get("pipeline", {}).get("frames_processed", 0)
        interval_sec = snapshot.get("_interval_sec", 60)
        actual_fps = (frames_processed - prev_frames) / interval_sec if interval_sec > 0 else 0
        target_fps = server.get("target_fps", 2.0)
        if target_fps > 0 and actual_fps < target_fps * 0.5 and actual_fps >= 0:
            findings.append(WatchdogFinding(
                severity="warning", category="stream",
                title=f"Actual FPS ({actual_fps:.1f}) well below target ({target_fps})",
                detail=f"Processed {frames_processed - prev_frames} frames in {interval_sec}s = {actual_fps:.1f} fps vs target {target_fps}",
                suggestion="Stream source may be buffering or system is overloaded.",
                snapshot_id=snap_id,
            ))

    # 7. LLM latency spike
    llm_p95 = llm.get("latency_p95_ms", 0)
    if llm_p95 > 10000:
        findings.append(WatchdogFinding(
            severity="warning", category="llm",
            title=f"LLM P95 latency very high ({llm_p95:.0f}ms)",
            detail=f"P95: {llm_p95:.0f}ms, P50: {llm.get('latency_p50_ms', 0):.0f}ms",
            suggestion="LLM provider may be experiencing degraded performance.",
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
    '"detail": string, "suggestion": string}. '
    "Categories: perception, drift, llm, stream, scene, system. "
    "Focus on actionable issues. Do NOT report normal/healthy metrics as findings. "
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
            findings.append(WatchdogFinding(
                severity=item.get("severity", "info"),
                category=item.get("category", "system"),
                title=item.get("title", "AI finding"),
                detail=item.get("detail", ""),
                suggestion=item.get("suggestion", ""),
                snapshot_id=snap_id,
            ))
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
        # Deduplicate: skip AI findings whose title already appears in rule findings
        rule_titles = {f.title for f in findings}
        for af in ai_findings:
            if af.title not in rule_titles:
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
