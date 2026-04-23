"""Perception hot path: stream capture, detection, gating, egomotion, depth.

The "eyes" of the system. Every frame passes through modules here
before any business logic runs: [stream.py](stream.py) pulls frames,
[detection.py](detection.py) runs YOLO + ByteTrack with TTC / distance
math, [egomotion.py](egomotion.py) estimates ego-speed, [context.py](context.py)
classifies the scene, and [quality.py](quality.py) suppresses events
when the feed itself is degraded. The invariant: a real conflict must
pass every gate; noise fails early.

UI connection
-------------
Page: Live page, Events page
UI element: indirect; every bbox, TTC value, and risk badge rendered in
            the SPA traces back to a gate defined in this package.
"""
