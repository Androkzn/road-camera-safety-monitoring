"""Image + video rendering helpers for the admin UI.

Three cohesive concerns split into submodules:

* :mod:`road_safety.rendering.frame` — per-frame bbox overlay for the live
  admin tile (``render_annotated_frame``) and the boot-time warming-up
  placeholder JPEG (``WARMING_UP_JPEG``).
* :mod:`road_safety.rendering.clip` — on-demand annotated MP4 clip
  rendering for ``/api/events/{id}/clip`` (``render_annotated_event_clip``).
* :mod:`road_safety.rendering.mjpeg` — ``StreamingResponse`` builder for
  the MJPEG video feed (``mjpeg_response``).

Extracted from ``server.py`` as part of the refactor plan, step 3.
Behaviour unchanged.
"""
