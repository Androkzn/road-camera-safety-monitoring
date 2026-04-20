"""Perception hot path + event emission, extracted from ``server.py``.

Structure (refactor plan step 7):

* :mod:`backend.perception.risk` — pure utilities (``classify_with_scene``,
  ``pair_key``, ``_none_coro``).
* :mod:`backend.perception.broadcast` — SSE fan-out helpers.
* :mod:`backend.perception.emit` — async event emission + feedback hook +
  event lookup.
* :mod:`backend.perception.episode_emit` — episode-to-event materialisation.
* :mod:`backend.perception.on_frame` — the perception hot path.
* :mod:`backend.perception.slot_control` — per-slot lifecycle helpers.
* :mod:`backend.perception.score_decay` — background score-decay task.

Nothing in this package changed behaviourally — only the location.
"""
