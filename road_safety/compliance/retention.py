"""Data retention policy — automatic expiry of old events, thumbnails, and feedback.

GDPR Art. 5(1)(e) requires that personal data be kept only as long as
necessary. Dashcam video thumbnails contain faces and plates (even redacted
copies carry metadata risk). This module enforces configurable retention
windows and runs as a periodic background task.

Retention windows (env-configurable):
  ROAD_RETENTION_THUMBNAILS_DAYS  — delete thumbnails older than N days (default 30)
  ROAD_RETENTION_FEEDBACK_DAYS    — trim feedback.jsonl entries older than N days (default 90)
  ROAD_RETENTION_AL_PENDING_DAYS  — delete stale active-learning samples (default 60)
  ROAD_RETENTION_OUTBOUND_DAYS    — trim outbound_queue.jsonl (default 7)
  ROAD_RETENTION_INTERVAL_SEC     — how often the sweep runs (default 3600 = hourly)

Design: never raises, never blocks the main loop, logs what it removes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

logger = logging.getLogger("retention")

THUMBNAILS_DAYS = int(os.getenv("ROAD_RETENTION_THUMBNAILS_DAYS", "30"))
FEEDBACK_DAYS = int(os.getenv("ROAD_RETENTION_FEEDBACK_DAYS", "90"))
AL_PENDING_DAYS = int(os.getenv("ROAD_RETENTION_AL_PENDING_DAYS", "60"))
OUTBOUND_DAYS = int(os.getenv("ROAD_RETENTION_OUTBOUND_DAYS", "7"))
INTERVAL_SEC = int(os.getenv("ROAD_RETENTION_INTERVAL_SEC", "3600"))

from road_safety.config import DATA_DIR


def _age_days(path: Path) -> float:
    try:
        mtime = path.stat().st_mtime
        return (time.time() - mtime) / 86400.0
    except OSError:
        return 0.0


def sweep_thumbnails(max_age_days: int = THUMBNAILS_DAYS) -> int:
    thumbs_dir = DATA_DIR / "thumbnails"
    if not thumbs_dir.exists():
        return 0
    removed = 0
    for f in thumbs_dir.iterdir():
        if not f.is_file() or not f.suffix in (".jpg", ".jpeg", ".png"):
            continue
        if _age_days(f) > max_age_days:
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def sweep_al_pending(max_age_days: int = AL_PENDING_DAYS) -> int:
    pending = DATA_DIR / "active_learning" / "pending"
    if not pending.exists():
        return 0
    removed = 0
    for f in pending.iterdir():
        if not f.is_file():
            continue
        if _age_days(f) > max_age_days:
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def _trim_jsonl(path: Path, max_age_days: int) -> int:
    """Remove lines from a JSONL file that are older than max_age_days.

    Looks for 'operator_ts', 'wall_time', or 'sampled_at' ISO fields.
    Falls back to keeping lines where no timestamp is parseable.
    """
    if not path.exists():
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0

    kept: list[str] = []
    removed = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            kept.append(line)
            continue
        ts_str = rec.get("operator_ts") or rec.get("wall_time") or rec.get("sampled_at")
        if not ts_str:
            kept.append(line)
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            if ts < cutoff:
                removed += 1
                continue
        except (ValueError, TypeError):
            pass
        kept.append(line)

    if removed > 0:
        try:
            path.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        except OSError:
            return 0
    return removed


def sweep_feedback(max_age_days: int = FEEDBACK_DAYS) -> int:
    return _trim_jsonl(DATA_DIR / "feedback.jsonl", max_age_days)


def sweep_outbound(max_age_days: int = OUTBOUND_DAYS) -> int:
    return _trim_jsonl(DATA_DIR / "outbound_queue.jsonl", max_age_days)


def run_sweep() -> dict:
    """Run all retention sweeps. Returns a summary of what was removed."""
    results = {
        "thumbnails_removed": sweep_thumbnails(),
        "al_pending_removed": sweep_al_pending(),
        "feedback_trimmed": sweep_feedback(),
        "outbound_trimmed": sweep_outbound(),
        "swept_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    total = sum(v for v in results.values() if isinstance(v, int))
    if total > 0:
        logger.info("retention sweep: %s", results)
    return results


async def retention_loop(interval_sec: int = INTERVAL_SEC) -> None:
    """Background task — runs run_sweep() periodically."""
    logger.info("retention loop started (interval=%ds, thumbs=%dd, feedback=%dd, al=%dd, outbound=%dd)",
                interval_sec, THUMBNAILS_DAYS, FEEDBACK_DAYS, AL_PENDING_DAYS, OUTBOUND_DAYS)
    # Sweep on startup so anything accumulated during downtime is collected immediately
    # rather than waiting a full interval. Critical when THUMBNAILS_DAYS=0.
    try:
        run_sweep()
    except Exception as exc:
        logger.warning("retention startup sweep error: %s", exc)
    while True:
        try:
            await asyncio.sleep(interval_sec)
            run_sweep()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("retention sweep error: %s", exc)
