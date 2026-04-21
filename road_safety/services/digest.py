"""digest.py — timed Slack notification flushers.

What it does:
    Runs two always-on background timers. One ticks every hour and sends
    a Slack "digest" message summarising medium-risk events. The other
    ticks once every 24 hours and sends a Slack "daily summary" for
    low-risk events. High-risk alerts are sent immediately elsewhere —
    this file only handles the two buffered tiers.

Purpose:
    Prevents Slack noise. Low and medium events are too frequent to post
    one-by-one, so they are batched here and released on a fixed cadence,
    giving operators a quiet channel instead of a firehose.

How it works:
    * ``async def`` means a function can pause and let other tasks run in
      the same thread — the web server interleaves them so the timer
      doesn't block API requests.
    * ``await asyncio.sleep(N)`` pauses the timer for N seconds without
      freezing anything else.
    * ``start_schedulers(loop)`` creates the two tasks once and is
      idempotent — calling it twice returns the existing handles instead
      of spawning duplicates. Errors inside each loop are caught and
      logged so a bad Slack call never kills the timer.
    * Intervals read from env at import time:
        ``DIGEST_INTERVAL_SEC`` (default 3600 = 1 hour)
        ``DAILY_INTERVAL_SEC``  (default 86400 = 24 hours)

Connects to:
    - Backend: started from ``road_safety/server.py`` at app startup;
      calls ``road_safety.integrations.slack.flush_medium_digest`` and
      ``flush_low_daily``.
    - UI: none — backend-only. Output lands in Slack, not the dashboard.
"""

from __future__ import annotations

import asyncio
import os
import traceback

from road_safety.integrations import slack as slack_notify

DIGEST_INTERVAL_SEC: int = int(os.getenv("DIGEST_INTERVAL_SEC", "3600"))
DAILY_INTERVAL_SEC: int = int(os.getenv("DAILY_INTERVAL_SEC", "86400"))

# Idempotency: start_schedulers() may be called more than once (e.g. reload);
# we hand back the existing tasks instead of spawning duplicates.
_started: bool = False
_tasks: tuple[asyncio.Task, asyncio.Task] | None = None


async def digest_scheduler(interval_sec: int = DIGEST_INTERVAL_SEC) -> None:
    """Periodically flush the medium-risk buffer as one Slack digest."""
    print(f"[digest] medium-risk scheduler online — interval {interval_sec}s")
    while True:
        try:
            await asyncio.sleep(interval_sec)
            await slack_notify.flush_medium_digest()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[digest] medium flush error: {exc}")
            traceback.print_exc()
            # keep going — one bad flush must not tear down the loop


async def daily_scheduler(interval_sec: int = DAILY_INTERVAL_SEC) -> None:
    """Periodically flush the low-risk buffer as a daily Slack summary."""
    print(f"[digest] low-risk daily scheduler online — interval {interval_sec}s")
    while True:
        try:
            await asyncio.sleep(interval_sec)
            await slack_notify.flush_low_daily()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[digest] daily flush error: {exc}")
            traceback.print_exc()


def start_schedulers(
    loop: asyncio.AbstractEventLoop,
) -> tuple[asyncio.Task, asyncio.Task]:
    """Create both scheduler tasks on ``loop``. Idempotent — safe to call more
    than once; subsequent calls return the existing task handles."""
    global _started, _tasks
    if _started and _tasks is not None:
        return _tasks
    medium_task = loop.create_task(
        digest_scheduler(DIGEST_INTERVAL_SEC), name="digest_scheduler_medium"
    )
    daily_task = loop.create_task(
        daily_scheduler(DAILY_INTERVAL_SEC), name="digest_scheduler_daily"
    )
    _tasks = (medium_task, daily_task)
    _started = True
    print(
        f"[digest] schedulers started "
        f"(medium={DIGEST_INTERVAL_SEC}s, daily={DAILY_INTERVAL_SEC}s)"
    )
    return _tasks
