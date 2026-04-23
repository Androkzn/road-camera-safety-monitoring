"""Image output: JPEG encoding, clip assembly.

Two cohesive rendering concerns: [frame.py](frame.py) draws per-frame
bbox overlays for the live admin tile (``render_annotated_frame``) and
provides the boot-time ``WARMING_UP_JPEG`` placeholder; [clip.py](clip.py)
builds on-demand annotated MP4 clips for the ``/api/events/{id}/clip``
endpoint.

UI connection
-------------
Page: Live page, Events page
UI element: the polled ``<img>`` tile served via ``/admin/frame/{id}``,
            annotated event thumbnails, and the clip-playback video
            element on event detail views.
"""
