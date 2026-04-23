"""Per-source domain objects (Episode + StreamSlot) + constants.

Lives outside ``state.py`` to keep that file small. :class:`Episode`
handles temporal de-duplication of conflict pairs across frames;
:class:`StreamSlot` holds per-source perception state. ``state.py``
still re-exports these names so legacy
``from backend.state import Episode`` imports keep working.

Re-exports
----------
Makes the following names importable from this package:
- ``Episode`` — from [episode.py](episode.py)
- ``MIN_HIGH_RISK_EPISODE_SEC`` — from [episode.py](episode.py)
- ``MIN_HIGH_RISK_FRAMES`` — from [episode.py](episode.py)
- ``MIN_MEDIUM_RISK_FRAMES`` — from [episode.py](episode.py)
- ``StreamSlot`` — from [stream_slot.py](stream_slot.py)

UI connection
-------------
Page: Live page, Events page
UI element: indirect; every rendered event card corresponds to an
            ``Episode`` materialised from a ``StreamSlot``.
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
