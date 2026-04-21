"""Image output: JPEG encoding, MJPEG streaming, clip assembly.

Three cohesive rendering concerns: [frame.py](frame.py) draws per-frame
bbox overlays for the live admin tile (``render_annotated_frame``) and
provides the boot-time ``WARMING_UP_JPEG`` placeholder;
[clip.py](clip.py) builds on-demand annotated MP4 clips for the
``/api/events/{id}/clip`` endpoint; [mjpeg.py](mjpeg.py) wraps the
MJPEG ``StreamingResponse`` used by the live video feed.

UI connection
-------------
Page: Live page, Events page
UI element: the ``<img>`` MJPEG tile, annotated event thumbnails, and
            the clip-playback video element on event detail views.
"""
