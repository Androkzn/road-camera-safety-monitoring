"""Background schedulers for tiered Slack alerting.

Two long-lived asyncio tasks:
  * digest_scheduler  — hourly (default), flushes the medium buffer
  * daily_scheduler   — every 24h (default), flushes the low buffer

Intervals are overridable via environment for demos/testing:
    DIGEST_INTERVAL_SEC  (default 3600)  — set to 60 to flush every minute
    DAILY_INTERVAL_SEC   (default 86400)

Intentionally minimal: no cron, no sqlite, no config file. If a flush raises,
we log and keep looping — transient Slack/network errors must not kill the
scheduler.
"""

from __future__ import annotations

import asyncio
import os
import traceback

import slack_notify

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
