"""MJPEG ``StreamingResponse`` builder for the admin video feed.

Shared by the legacy primary-only ``/admin/video_feed`` endpoint and
the new per-source ``/admin/video_feed/{source_id}`` endpoint.

Extracted from ``server.py`` as part of the refactor plan, step 3.
Behaviour unchanged.
"""

import time

from fastapi.responses import StreamingResponse

from backend.rendering.frame import WARMING_UP_JPEG
from backend.state import StreamSlot


def mjpeg_response(slot: StreamSlot) -> StreamingResponse:
    """Build an MJPEG ``StreamingResponse`` reading from ``slot``'s buffer.

    Shared by the legacy primary-only ``/admin/video_feed`` endpoint and
    the new per-source ``/admin/video_feed/{source_id}`` endpoint.

    Behaviour: while the slot has not yet published its first annotated
    frame, we send a "Warming up…" placeholder JPEG instead of nothing.
    That keeps the browser's MJPEG connection alive so the very next real
    frame swaps in cleanly — without it, slots that finish booting after
    the page loads strand the browser on a stalled stream that renders as
    a black tile for the rest of the session.
    """

    def generate():
        # Announce ourselves as an active viewer so the perception loop
        # actually produces annotated JPEGs for this slot. When the client
        # disconnects, StreamingResponse closes the generator which fires
        # the finally block below and releases the viewer slot — so the
        # encode cost stops the moment the tile is unmounted.
        slot._acquire_viewer()
        try:
            # Emit the placeholder ONCE up front so the <img> tag receives
            # data immediately — even browsers that time out on a 4 s
            # no-data stream stay connected.
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + WARMING_UP_JPEG + b"\r\n"
            )
            sent_real = False
            while True:
                with slot._frame_lock:
                    jpeg = slot._annotated_jpeg
                if jpeg is not None:
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                    )
                    sent_real = True
                elif not sent_real:
                    # Still warming up — keep the placeholder visible (and the
                    # connection alive) instead of yielding nothing.
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + WARMING_UP_JPEG + b"\r\n"
                    )
                # ~0.4s matches the 2fps perception tick; faster would resend
                # identical frames.
                time.sleep(0.4)
        finally:
            slot._release_viewer()

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
