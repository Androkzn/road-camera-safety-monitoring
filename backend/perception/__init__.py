"""Orchestration glue between the hot path and the rest of the app.

Wires [core/](../core/) detections into event emission, risk scoring,
and slot control. Split into [risk.py](risk.py) (pure classification
utilities), [broadcast.py](broadcast.py) (SSE fan-out),
[emit.py](emit.py) (async event emission + feedback hook),
[episode_emit.py](episode_emit.py) (episode-to-event materialisation),
[on_frame.py](on_frame.py) (the perception hot path dispatcher),
[slot_control.py](slot_control.py) (per-slot lifecycle), and
[score_decay.py](score_decay.py) (background driver-score decay).

UI connection
-------------
Page: Live page, Events page
UI element: indirect; the SSE stream consumed by the live dashboard
            and every emitted event card flows through ``emit``.
"""
