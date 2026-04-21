"""retention.py — the "auto-delete after N days" janitor for personal data.

What it does:
    Walks through four data locations on a schedule (roughly once per
    hour) and deletes anything older than a configurable cutoff:
      1. Thumbnail JPG/PNG files — the still images captured for each
         event, which contain faces and licence plates.
      2. Feedback history (``data/feedback.jsonl``) — the operator
         thumbs-up / thumbs-down verdicts tied to an event_id.
      3. Active-learning "pending" samples — see below.
      4. Outbound cloud-upload queue (``data/outbound_queue.jsonl``) —
         see below.
    Anything newer than the cutoff is left untouched. Nothing is ever
    moved to a trash folder; deletion is permanent, which is the whole
    point (GDPR "right to be forgotten" and storage minimisation).

Purpose:
    GDPR Article 5(1)(e) says personal data must be kept "no longer than
    is necessary". A dashcam captures faces and plates constantly — if
    the system never cleaned up, the edge device's disk would fill and
    the fleet operator would be in breach of its own privacy notice.
    This module is the enforcement mechanism. It also keeps the edge
    device's disk from filling up, which would crash the capture pipeline.

How it works:
    The module defines five small "sweep" functions and one loop that
    calls them all. Each sweep is independent and returns the count of
    items it removed, so the summary that gets written to the app log
    looks like ``{'thumbnails_removed': 12, 'feedback_trimmed': 4, ...}``.

    Vocabulary the user may not know:
      * "Active-learning samples" are event payloads that the model
        flagged as low-confidence or contested by operator feedback and
        that a future training job will want to look at again. They live
        at ``data/active_learning/pending/``. If they're never exported,
        they shouldn't accumulate forever — hence the default 60-day cap.
      * ``outbound_queue.jsonl`` is the local buffer of events that the
        edge device wants to send to the cloud (see
        ``integrations/edge_publisher.py``). If the cloud is unreachable
        for a long time, rows pile up here. The 7-day default trim
        prevents an outage from turning into a full-disk incident.
      * "Periodic background task" means an ``async def`` function that
        Python's ``asyncio`` event loop runs alongside the HTTP server.
        ``asyncio.sleep(interval_sec)`` pauses the task without blocking
        any other request — when the sleep is over, ``run_sweep()`` runs
        once, and the loop repeats forever. ``except asyncio.CancelledError:
        raise`` means: when the server shuts down, let the cancellation
        propagate so the task exits cleanly.

    The file trimming helper ``_trim_jsonl`` is conservative: it reads
    every line, tries to parse JSON, and only drops a line if it finds
    a recognisable ISO-8601 timestamp (``operator_ts``, ``wall_time``,
    or ``sampled_at``) that is older than the cutoff. Unparseable lines
    and lines without a timestamp are kept — the module errs on "don't
    delete something I can't prove is old".

Retention windows (override via environment variables at process start):
    ROAD_RETENTION_THUMBNAILS_DAYS  default 30  — thumbnail image files
    ROAD_RETENTION_FEEDBACK_DAYS    default 90  — feedback.jsonl rows
    ROAD_RETENTION_AL_PENDING_DAYS  default 60  — active-learning pending
    ROAD_RETENTION_OUTBOUND_DAYS    default 7   — outbound_queue.jsonl rows
    ROAD_RETENTION_INTERVAL_SEC     default 3600 — how often the sweep runs

Safety notes:
    Every sweep wraps its filesystem calls in ``try/except OSError`` and
    returns a zero/empty result on failure, so a single unreadable file
    cannot crash the loop. The outer loop also swallows generic
    exceptions and logs them. The goal is "never take the edge device
    down because the janitor hit a permission error".

Connects to:
    - Backend: imported by ``road_safety/server.py``, which both starts
      ``retention_loop()`` as a background task during app startup and
      exposes ``POST /api/retention/sweep`` to let an admin trigger an
      immediate run. The ``audit`` module records each sweep under the
      action name ``"retention_sweep"``.
    - UI: none directly today — no component in ``frontend/src`` hits
      ``/api/retention/*``. The sweep runs silently. A future admin
      surface could surface ``run_sweep()``'s return dict as a "last
      cleanup" tile on the compliance panel.
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
    while True:
        try:
            await asyncio.sleep(interval_sec)
            run_sweep()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("retention sweep error: %s", exc)
