"""Domain objects owned by the live perception pipeline.

This package holds the value / stateful classes that model the perception
pipeline's *shape* — as opposed to:

    * ``backend/state.py``         — the process-wide singleton glue.
    * ``backend/core/``            — frame-level perception primitives
                                      (YOLO, egomotion, quality, scene).
    * ``backend/api/models.py``    — wire-format request/response shapes.
    * ``backend/services/``        — cross-cutting long-lived services
                                      (LLM, drift, watchdog, registry).

Today it contains :class:`Episode` (temporal de-duplication of conflict
pairs across frames) and :class:`StreamSlot` (per-source perception state).
Both classes used to live inline in ``backend/state.py`` — that file grew
past 800 lines and mixed three concerns (domain objects, the ``LiveState``
singleton, and identity resolution). Splitting them out keeps each file
focused on one job.

For backwards compatibility ``backend/state.py`` re-exports these names,
so existing ``from backend.state import Episode, StreamSlot`` lines keep
working unchanged.
"""

from __future__ import annotations

from backend.domain.episode import (
    MIN_HIGH_RISK_EPISODE_SEC,
    MIN_HIGH_RISK_FRAMES,
    MIN_MEDIUM_RISK_FRAMES,
    Episode,
)
from backend.domain.stream_slot import StreamSlot

__all__ = [
    "Episode",
    "MIN_HIGH_RISK_EPISODE_SEC",
    "MIN_HIGH_RISK_FRAMES",
    "MIN_MEDIUM_RISK_FRAMES",
    "StreamSlot",
]
