"""Admin video feed routes (MJPEG + poll-based frame + media-token mint)."""

import time

import cv2
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from backend.config import THUMB_SIGNING_SECRET
from backend.logging import get_logger
from backend.rendering.frame import WARMING_UP_JPEG
from backend.rendering.mjpeg import mjpeg_response
from backend.security.auth import require_admin
from backend.security.signing import (
    MEDIA_TOKEN_TTL_SEC,
    media_token,
    require_media_auth,
)
from backend.state import state

log = get_logger(__name__)

router = APIRouter()


@router.get("/admin/video_feed")
def admin_video_feed(request: Request):
    """MJPEG stream of annotated frames for the PRIMARY source.

    HTTP: GET /admin/video_feed
    AUTH: signed URL (BE-D13) OR admin bearer when ROAD_REQUIRE_AUTH=1.
          Falls through to public when the flag is off (pre-cutover).

    Response: ``multipart/x-mixed-replace`` stream — each JPEG part is a
        freshly-annotated frame. Consumer renders in an ``<img>`` tag.

    For multi-source UIs prefer ``/admin/video_feed/{source_id}``.
    """
    primary_id = state.PRIMARY_ID or "primary"
    require_media_auth(f"mjpeg:{primary_id}", request, realm="media:mjpeg")
    return mjpeg_response(state.primary_slot)


@router.get("/admin/video_feed/{source_id}")
def admin_video_feed_for(source_id: str, request: Request):
    """Per-source MJPEG stream — one slot's annotated frames.

    HTTP: GET /admin/video_feed/{source_id}
    AUTH: signed URL (BE-D13) OR admin bearer when ROAD_REQUIRE_AUTH=1.
          Falls through to public when the flag is off (pre-cutover).
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
    #
    # AUTH: signed URL (BE-D13) OR admin bearer when ROAD_REQUIRE_AUTH=1;
    # falls through to public otherwise.
    require_media_auth(f"frame:{source_id}", request, realm="media:frame")
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    # Signal to ``_on_frame`` that this slot has a viewer, so the encode path
    # actually runs. Without this the cached jpeg stays ``None`` forever.
    slot.mark_polled()
    with slot._frame_lock:
        jpeg = slot._annotated_jpeg
        # Capture a reference under the lock; only used if jpeg is missing.
        raw = slot._latest_raw_frame if jpeg is None else None
    # Encode-on-demand fallback. Covers two cases that previously made non-
    # primary tiles look broken:
    #   * First few polls after page-load arrive BEFORE the slot's first
    #     ``_on_frame`` tick has produced an annotated JPEG.
    #   * Under heavy contention (6 streams sharing one YOLO instance), the
    #     annotated encode lags behind the poll cadence; without this we'd
    #     return 503 and the <img> onError would mark the tile permanently
    #     errored, hiding the live feed even after fresh frames arrived.
    # Encoded without bbox overlays — operators still see the live video,
    # detections appear as soon as the next annotated tick lands.
    if jpeg is None and raw is not None:
        try:
            ok, buf = cv2.imencode(".jpg", raw, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                jpeg = buf.tobytes()
        except Exception as exc:
            log.warning("on-demand frame encode failed (%s): %s", source_id, exc)
    if jpeg is None:
        # Still nothing — stream truly hasn't produced its first frame. Send
        # the warming-up placeholder so the <img> onError doesn't fire and
        # poison the tile; the next poll will pick up a real frame.
        jpeg = WARMING_UP_JPEG
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/live/media_token")
def live_media_token(request: Request, source_id: str, stream: str = "mjpeg"):
    """Mint a short-lived signed URL for a live-video / detections endpoint.

    HTTP: GET /api/live/media_token?source_id=<id>&stream=<mjpeg|frame|detections>
    AUTH: admin bearer — UNCONDITIONAL (not gated by ROAD_REQUIRE_AUTH).
          Minting is always auth-checked so an operator can't hand out
          short-lived URLs by accident during the release-N window.

    Implements BE-D13 from the 2026-04-20 backend audit. The browser
    APIs (``<img src>``, ``EventSource``) can't send custom headers, so
    operator UI fetches a signed URL via this JSON endpoint and then
    plugs ``?exp=&token=`` into the MJPEG / frame / SSE URL. The TTL is
    5 minutes; the FE is expected to auto-refresh before expiry.

    Query params:
        source_id: Stream slot id. Must match a slot in ``state.slots``
            except when ``stream=detections`` (which is site-wide).
        stream: One of ``mjpeg`` | ``frame`` | ``detections``.

    Returns:
        ``{"url": "<path>?exp=<int>&token=<hex>", "expires_at": <int>}``.
    """
    require_admin(request, realm="media token")

    stream_norm = (stream or "").strip().lower()
    if stream_norm not in {"mjpeg", "frame", "detections"}:
        raise HTTPException(400, "stream must be one of: mjpeg, frame, detections")

    if not THUMB_SIGNING_SECRET:
        # Mint cannot produce a valid signature without the shared secret.
        # Fail loud so the operator surfaces the missing env var.
        raise HTTPException(
            503,
            "ROAD_THUMB_SIGNING_SECRET (or ROAD_CLOUD_HMAC_SECRET) must be set "
            "to mint signed media URLs",
        )

    if stream_norm == "detections":
        # SSE is global; ``source_id`` is accepted for URL symmetry but
        # the signature always binds to the constant key.
        stream_key = "detections:all"
        path = "/admin/detections"
    else:
        sid = (source_id or "").strip()
        if not sid:
            raise HTTPException(400, "missing source_id")
        if sid not in state.slots:
            raise HTTPException(404, f"unknown source: {sid}")
        stream_key = f"{stream_norm}:{sid}"
        path = (
            f"/admin/video_feed/{sid}" if stream_norm == "mjpeg"
            else f"/admin/frame/{sid}"
        )

    exp = int(time.time()) + MEDIA_TOKEN_TTL_SEC
    token = media_token(stream_key, exp)
    return {
        "url": f"{path}?exp={exp}&token={token}",
        "expires_at": exp,
    }
