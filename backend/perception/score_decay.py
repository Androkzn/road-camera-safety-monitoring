"""Background timer that slowly forgets old driver-safety-score events.

Every driver in the system has a safety score that goes down when they
are involved in an incident. To keep yesterday's mistakes from
permanently dragging today's score down, this file runs a quiet timer
in the background that nudges all scores back toward neutral on a fixed
schedule. It does not look at video or detect anything itself.

UI connection
-------------
No direct UI — runs inside the perception background tasks. Its output
eventually appears as the per-driver safety-score numbers shown on the
fleet dashboard ([DashboardPage.tsx](frontend/src/features/dashboard/DashboardPage.tsx)),
which would otherwise stay stuck at old values forever.
"""

import asyncio

from backend.logging import get_logger
from backend.services.registry import road_registry

log = get_logger(__name__)


async def score_decay_loop(interval_sec: int) -> None:
    """Long-running background task: periodically decay attribution safety scores.

    The attribution-score model in ``services/registry.py`` (keyed on the
    ``driver_id`` attribution slot) decays over time so yesterday's
    incidents don't permanently dominate today's score. This loop triggers
    that decay on a fixed cadence.

    Args:
        interval_sec: Seconds between decay passes. Sourced from
            ``ROAD_SCORE_DECAY_INTERVAL_SEC``; 0 disables the loop
            entirely (handled by the caller in ``lifespan``).

    Raises:
        asyncio.CancelledError: Re-raised on shutdown so the task cleanly
            terminates when ``lifespan`` cancels it.
    """
    while True:
        try:
            await asyncio.sleep(interval_sec)
            road_registry.decay_scores()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Narrow log-and-continue: one failed decay pass shouldn't
            # take the whole loop down — the next cycle retries cleanly.
            log.warning("score decay loop failed: %s", exc)
