"""Admin video feed routes (MJPEG + poll-based frame).

Two transports are exposed per source so the frontend can pick whichever
is compatible with the current protocol (see CLAUDE.md note on HTTP/1.1
vs HTTP/2 connection limits):

* ``/admin/video_feed[/<id>]`` — MJPEG multipart stream (one persistent
  connection per tile).
* ``/admin/frame/<id>`` — single JPEG per call (polled at ~2.5 Hz).

UI connection
-------------
Page: AdminPage — [file](frontend/src/features/admin/AdminPage.tsx)
UI element: the live video grid tiles — every camera tile in the multi-source
grid pulls its picture from one of these two endpoints (MJPEG over HTTPS,
poll over HTTP).
Backend route(s): GET /admin/video_feed, GET /admin/video_feed/{source_id},
GET /admin/frame/{source_id}.
"""

import cv2
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from backend.logging import get_logger
from backend.rendering.frame import WARMING_UP_JPEG
from backend.rendering.mjpeg import mjpeg_response
from backend.state import state

log = get_logger(__name__)

# ``APIRouter`` — route grouping container.
router = APIRouter()


@router.get("/admin/video_feed")
def admin_video_feed():
    """MJPEG stream of annotated frames for the PRIMARY source.

    HTTP: GET /admin/video_feed
    Response: ``multipart/x-mixed-replace`` — the browser renders each
        JPEG part in place, producing a live video effect with no
        polling latency floor.
    """
    return mjpeg_response(state.primary_slot)


@router.get("/admin/video_feed/{source_id}")
def admin_video_feed_for(source_id: str):
    """Per-source MJPEG stream — one slot's annotated frames.

    HTTP: GET /admin/video_feed/{source_id}
    Raises: 404 if ``source_id`` is not a registered slot.
    """
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    return mjpeg_response(slot)


@router.get("/admin/frame/{source_id}")
def admin_frame_for(source_id: str):
    """Return the latest single JPEG frame for a source.

    HTTP: GET /admin/frame/{source_id}
    Response: a one-shot ``image/jpeg`` with ``Cache-Control: no-store``.
        Clients that can't use MJPEG poll this endpoint every ~400 ms.

    Why a polling fallback exists: MJPEG holds a persistent multipart
    connection per tile, which bumps into the browser's 6-concurrent-
    connections-per-host cap once you have >4 tiles + the SSE channel
    open. Polling short-lived JPEGs dodges that cap.
    """
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    slot.mark_polled()
    # ``with slot._frame_lock`` — threading lock used as a context
    # manager: acquires on entry, releases on exit even if we raise.
    with slot._frame_lock:
        jpeg = slot._annotated_jpeg
        raw = slot._latest_raw_frame if jpeg is None else None
    if jpeg is None and raw is not None:
        try:
            # Fallback path: annotator hasn't produced a JPEG yet — encode
            # the raw frame on demand at quality 70.
            ok, buf = cv2.imencode(".jpg", raw, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                jpeg = buf.tobytes()
        except Exception as exc:
            log.warning("on-demand frame encode failed (%s): %s", source_id, exc)
    if jpeg is None:
        # Placeholder when the stream hasn't warmed up (e.g. right after
        # a slot is added).
        jpeg = WARMING_UP_JPEG
    # ``Response`` is the low-level FastAPI response with explicit bytes
    # + content type — used when you need to control the media type
    # precisely rather than let FastAPI infer JSON.
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )
