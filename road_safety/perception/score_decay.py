"""Long-running asyncio task: periodic attribution safety-score decay.

Spawned from the lifespan hook. Extracted from ``server.py`` (step 7).
"""

import asyncio

from road_safety.logging import get_logger
from road_safety.services.registry import road_registry

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
