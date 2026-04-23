"""Admin video feed routes (single-JPEG polling).

At 2 fps source data, a ~400 ms poll cadence delivers every frame the
edge produces — a push-based MJPEG transport would add complexity for
no perceptual gain. See CLAUDE.md "Live video transport (admin grid)".

UI connection
-------------
Page: AdminPage — [file](frontend/src/features/admin/AdminPage.tsx)
UI element: the live video grid tiles — every camera tile in the multi-source
grid polls this endpoint for its picture.
Backend route(s): GET /admin/frame/{source_id}.
"""

import cv2
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from backend.logging import get_logger
from backend.rendering.frame import WARMING_UP_JPEG
from backend.state import state

log = get_logger(__name__)

# ``APIRouter`` — route grouping container.
router = APIRouter()


@router.get("/admin/frame/{source_id}")
def admin_frame_for(source_id: str):
    """Return the latest single JPEG frame for a source.

    HTTP: GET /admin/frame/{source_id}
    Response: a one-shot ``image/jpeg`` with ``Cache-Control: no-store``.
        Clients poll this endpoint every ~400 ms.
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
