"""Perception hot path + event emission, extracted from ``server.py``.

Structure (refactor plan step 7):

* :mod:`road_safety.perception.risk` — pure utilities (``classify_with_scene``,
  ``pair_key``, ``_none_coro``).
* :mod:`road_safety.perception.broadcast` — SSE fan-out helpers.
* :mod:`road_safety.perception.emit` — async event emission + feedback hook +
  event lookup.
* :mod:`road_safety.perception.episode_emit` — episode-to-event materialisation.
* :mod:`road_safety.perception.on_frame` — the perception hot path.
* :mod:`road_safety.perception.slot_control` — per-slot lifecycle helpers.
* :mod:`road_safety.perception.score_decay` — background score-decay task.

Nothing in this package changed behaviourally — only the location.
"""
