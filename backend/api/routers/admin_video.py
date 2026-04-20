"""Admin video feed routes (MJPEG + poll-based frame). POC: no auth."""

import cv2
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from backend.logging import get_logger
from backend.rendering.frame import WARMING_UP_JPEG
from backend.rendering.mjpeg import mjpeg_response
from backend.security.signing import require_media_auth
from backend.state import state

log = get_logger(__name__)

router = APIRouter()


@router.get("/admin/video_feed")
def admin_video_feed(request: Request):
    """MJPEG stream of annotated frames for the PRIMARY source.

    HTTP: GET /admin/video_feed
    """
    primary_id = state.PRIMARY_ID or "primary"
    require_media_auth(f"mjpeg:{primary_id}", request, realm="media:mjpeg")
    return mjpeg_response(state.primary_slot)


@router.get("/admin/video_feed/{source_id}")
def admin_video_feed_for(source_id: str, request: Request):
    """Per-source MJPEG stream — one slot's annotated frames.

    HTTP: GET /admin/video_feed/{source_id}
    """
    require_media_auth(f"mjpeg:{source_id}", request, realm="media:mjpeg")
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    return mjpeg_response(slot)


@router.get("/admin/frame/{source_id}")
def admin_frame_for(source_id: str, request: Request):
    # Single-shot JPEG for the admin grid's polling renderer. MJPEG holds a
    # persistent multipart connection per tile, which bumps into the browser's
    # 6-concurrent-connections-per-host cap once you have >4 tiles + the SSE
    # channel open. Polling short-lived JPEGs dodges that cap.
    require_media_auth(f"frame:{source_id}", request, realm="media:frame")
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    slot.mark_polled()
    with slot._frame_lock:
        jpeg = slot._annotated_jpeg
        raw = slot._latest_raw_frame if jpeg is None else None
    if jpeg is None and raw is not None:
        try:
            ok, buf = cv2.imencode(".jpg", raw, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                jpeg = buf.tobytes()
        except Exception as exc:
            log.warning("on-demand frame encode failed (%s): %s", source_id, exc)
    if jpeg is None:
        jpeg = WARMING_UP_JPEG
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )
