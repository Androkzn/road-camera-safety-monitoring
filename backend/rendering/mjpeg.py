"""MJPEG ``StreamingResponse`` builder for the admin video feed.

Shared by the legacy primary-only ``/admin/video_feed`` endpoint and
the new per-source ``/admin/video_feed/{source_id}`` endpoint.

Extracted from ``server.py`` as part of the refactor plan, step 3.
Behaviour unchanged.

MJPEG primer
------------
MJPEG = "Motion JPEG". Instead of a real video codec, the server just
sends a stream of independent JPEG frames back-to-back on one HTTP
connection. The magic is in the ``Content-Type`` header:
``multipart/x-mixed-replace; boundary=frame`` tells the browser "this is
ONE response that contains MANY parts, separated by ``--frame``, and each
part REPLACES the previous one in the <img> element". So an ordinary
``<img src="/admin/video_feed/primary">`` tag becomes a live-updating
video tile without any JavaScript, WebSocket, or HLS playlist plumbing.

Trade-off: each stream holds a dedicated TCP connection open. Browsers
cap HTTP/1.1 connections at ~6 per origin, so ≥6 tiles on the same host
deadlock — see ``CLAUDE.md`` for the HTTP/2-proxy deployment note.

UI connection
-------------
Page: AdminPage
UI element: Powers the live video tiles in the multi-source admin grid,
       rendered by the ``StreamImage`` component when the page is served
       over HTTPS.
"""

import time

# ``StreamingResponse`` — FastAPI response type that takes a (sync or
# async) generator of bytes and streams them to the client. Perfect for
# MJPEG: we yield JPEG frames as they are produced, never buffering the
# whole video in memory.
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

    # Inner generator function — uses ``yield`` (see below) to produce a
    # stream of byte chunks. Each ``yield <bytes>`` becomes one chunk
    # written to the HTTP response body.
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
            #
            # Wire format: ``--frame\r\nContent-Type: image/jpeg\r\n\r\n``
            # is the multipart part-header. The two \r\n pairs delimit
            # headers from body exactly like an email attachment. The
            # ``b"..."`` prefix makes these byte literals (MJPEG is raw
            # bytes, not text). ``yield`` suspends the generator and hands
            # these bytes to FastAPI which writes them to the TCP socket.
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

    # ``media_type`` sets the Content-Type header. The
    # ``multipart/x-mixed-replace`` MIME type is what turns this from "a
    # slow HTTP download" into "a live video feed" — see module docstring.
    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
