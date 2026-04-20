"""Live status / perception / scene / drift / events routes.

These are the "read the live pipeline state" endpoints used by the
operator UI: header status bar, event list, per-event detail, event
clip download, and the drift + perception panels.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from backend.api.models import EventModel, LiveStatusResponse
from backend.compliance import audit
from backend.config import (
    ALPR_MODE,
    DATA_DIR,
    DSAR_TOKEN,
    LOCATION,
    PUBLIC_THUMBS_REQUIRE_TOKEN,
    TARGET_FPS,
)
from backend.integrations.slack import slack_configured
from backend.logging import get_logger
from backend.rendering.clip import render_annotated_event_clip
from backend.security.auth import require_admin, require_admin_if_flagged
from backend.security.rate_limit import clip_rate_limit_check
from backend.services.llm import llm_configured
from backend.state import state

log = get_logger(__name__)

router = APIRouter()


@router.get("/api/live/status", response_model=LiveStatusResponse)
def live_status():
    """Public health + configuration snapshot for the operator UI.

    HTTP: GET /api/live/status
    AUTH: public
    Response: a large dict with source label, running flag, frame counts,
        uptime, tracker/risk-model names, and PII-redaction config.

    BE-D8: consumes ``state.snapshot()`` (frozen under ``state.lock``) so
    every returned field is consistent with every other — no torn reads
    when the perception thread is mid-update.

    BE-D1 Option B: top-level fields remain primary-slot-biased for
    backwards compatibility; a new ``sources`` array + ``primary_id``
    expose every slot so FE can migrate incrementally before we drop
    the primary proxies in release N+1.
    """
    snap = state.snapshot()
    primary = next(
        (s for s in snap.sources if s.get("id") == snap.primary_source_id),
        None,
    )
    primary_slot = state.slots.get(snap.primary_source_id) or state.primary_slot
    q = primary_slot.quality.state()
    return {
        "source": state.source_label,
        "location": LOCATION,
        "running": bool(primary.get("running")) if primary else False,
        "event_count": snap.recent_events_count,
        "frames_read": primary.get("frames_read", 0) if primary else 0,
        "frames_processed": primary.get("frames_processed", 0) if primary else 0,
        "uptime_sec": primary.get("uptime_sec", 0.0) if primary else 0.0,
        "started_at": primary.get("started_at") if primary else None,
        "llm_configured": llm_configured(),
        "slack_configured": slack_configured(),
        "target_fps": TARGET_FPS,
        "active_episodes": snap.episodes_total,
        "tracker": "bytetrack",
        "risk_model": "ttc+ground_plane",
        "pii_redaction": "face+plate",
        "dsar_endpoint_enabled": bool(DSAR_TOKEN),
        "public_thumb_token_required": PUBLIC_THUMBS_REQUIRE_TOKEN,
        "alpr_mode": ALPR_MODE,
        "perception": {
            "state": q["state"],
            "reason": q["reason"],
            "samples": q["samples"],
            "since_sec": q["since_sec"],
            "avg_confidence": q["avg_confidence"],
            "luminance": q["luminance"],
            "sharpness": q["sharpness"],
        },
        "sources": list(snap.sources),
        "primary_id": snap.primary_source_id,
    }


@router.get("/api/live/perception")
def live_perception(source_id: str | None = None):
    """Return the perception-quality monitor's current state.

    HTTP: GET /api/live/perception[?source_id=<slot>]
    AUTH: public
    """
    if source_id is None:
        slot = state.primary_slot
    else:
        slot = state.slots.get(source_id)
        if slot is None:
            raise HTTPException(404, f"unknown source: {source_id}")
    return slot.quality.state()


@router.get("/api/live/scene")
def live_scene(source_id: str | None = None):
    """Current scene context + adaptive thresholds.

    HTTP: GET /api/live/scene[?source_id=<slot>]
    AUTH: public
    """
    if source_id is None:
        slot = state.primary_slot
    else:
        slot = state.slots.get(source_id)
        if slot is None:
            raise HTTPException(404, f"unknown source: {source_id}")
    ctx = slot.last_scene_ctx
    if ctx is None:
        return {"label": "unknown", "reason": "not yet observed"}
    thr = slot.scene.adaptive_thresholds(ctx)
    ego = slot.last_ego_flow
    return {
        "label": ctx.label,
        "confidence": round(ctx.confidence, 2),
        "speed_proxy_mps": (
            round(ctx.speed_proxy_mps, 2) if ctx.speed_proxy_mps is not None else None
        ),
        "pedestrian_rate_per_min": round(ctx.pedestrian_rate_per_min, 2),
        "vehicle_rate_per_min": round(ctx.vehicle_rate_per_min, 2),
        "reason": ctx.reason,
        "thresholds": {
            "ttc_high_sec": thr.ttc_high_sec,
            "ttc_med_sec": thr.ttc_med_sec,
            "dist_high_m": thr.dist_high_m,
            "dist_med_m": thr.dist_med_m,
        },
        "ego_flow": (
            {
                "speed_proxy_mps": round(ego.speed_proxy_mps, 2),
                "confidence": round(ego.confidence, 2),
            }
            if ego is not None else None
        ),
    }


@router.get("/api/drift")
def api_drift():
    """Rolling precision report.

    HTTP: GET /api/drift
    AUTH: public
    """
    return state.drift.compute().as_dict()


@router.get("/api/live/events", response_model=list[EventModel])
def live_events(risk_level: str | None = None, event_type: str | None = None, limit: int = 100):
    """Paginated read of live events with optional filters.

    HTTP: GET /api/live/events
    AUTH: public
    """
    items = state.recent_events_snapshot()
    if risk_level:
        items = [e for e in items if e["risk_level"] == risk_level]
    if event_type:
        items = [e for e in items if e["event_type"] == event_type]
    return items[-limit:]


@router.get("/api/events", response_model=list[EventModel])
def events(
    risk_level: str | None = None,
    event_type: str | None = None,
    limit: int = 500,
):
    """Live events from the in-memory recent-events buffer.

    HTTP: GET /api/events
    AUTH: public

    BE-D8: consumes ``state.snapshot()`` so the read is atomic with
    respect to the perception thread's appends.
    """
    snap = state.snapshot()
    items = list(snap.recent_events)
    if risk_level:
        items = [e for e in items if e.get("risk_level") == risk_level]
    if event_type:
        items = [e for e in items if e.get("event_type") == event_type]
    return items[-limit:]


@router.get("/api/events/{event_id}", response_model=EventModel)
def event(event_id: str):
    """Look up a single event by id.

    HTTP: GET /api/events/{event_id}
    AUTH: public
    Raises: 404 if no matching event is in the current buffer.
    """
    ev = state.find_recent_event(event_id)
    if ev is not None:
        return ev
    raise HTTPException(404, "event not found")


_CLIP_WINDOW_ALLOWED: frozenset[float] = frozenset({0.0, 1.0, 3.0, 5.0, 10.0})


@router.get("/api/events/{event_id}/clip")
def event_clip(
    event_id: str,
    request: Request,
    before: float = 3.0,
    after: float = 3.0,
    annotated: bool = True,
):
    """Serve a ±N-second MP4 clip centred on the event's timestamp.

    HTTP: GET /api/events/{event_id}/clip?before=3&after=3&annotated=1
    AUTH: admin bearer (gated by ROAD_REQUIRE_AUTH — BE-D14).
    """
    import shlex
    import subprocess

    require_admin_if_flagged(request, realm="clip")

    try:
        before_val = float(before)
        after_val = float(after)
    except (TypeError, ValueError):
        raise HTTPException(400, "before/after must be one of 0, 1, 3, 5, 10")
    if before_val not in _CLIP_WINDOW_ALLOWED or after_val not in _CLIP_WINDOW_ALLOWED:
        raise HTTPException(400, "before/after must be one of 0, 1, 3, 5, 10")
    before = before_val
    after = after_val

    event_obj = state.find_recent_event(event_id)
    if event_obj is None:
        raise HTTPException(404, "event not found")

    ts_sec = event_obj.get("timestamp_sec")
    source_id = event_obj.get("source_id")
    if ts_sec is None or not source_id:
        raise HTTPException(404, "event has no seekable source timestamp")

    slot = state.slots.get(source_id)
    if slot is None or not slot.original_source:
        raise HTTPException(404, "source slot not found")

    source_path = Path(slot.original_source)
    if not source_path.exists() or not source_path.is_file():
        raise HTTPException(
            404, "source is not a local file (live streams can't be clipped)",
        )

    start = max(0.0, float(ts_sec) - before)
    duration = before + after

    clips_dir = DATA_DIR / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    suffix = "_annotated" if annotated else ""
    cache_path = clips_dir / f"{event_id}_{before:g}_{after:g}{suffix}.mp4"

    if not cache_path.exists():
        if annotated:
            # BE-D14: rate-limit ONLY on cache miss. Subsequent requests
            # for the same window hit the cache and bypass this check.
            clip_rate_limit_check(request)
            try:
                render_annotated_event_clip(source_path, start, duration, cache_path)
            except FileNotFoundError:
                raise HTTPException(500, "ffmpeg not installed on server")
            except subprocess.TimeoutExpired:
                raise HTTPException(504, "annotated clip extraction timed out")
            except Exception as exc:  # noqa: BLE001
                log.warning("annotated clip extraction failed: %s", exc)
                annotated = False
                cache_path = clips_dir / f"{event_id}_{before:g}_{after:g}.mp4"
        if not annotated and not cache_path.exists():
            cmd = [
                "ffmpeg",
                "-y",
                "-ss", f"{start:.3f}",
                "-i", str(source_path),
                "-t", f"{duration:.3f}",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                "-an",
                str(cache_path),
            ]
            try:
                subprocess.run(cmd, check=True, capture_output=True, timeout=30)
            except FileNotFoundError:
                raise HTTPException(500, "ffmpeg not installed on server")
            except subprocess.TimeoutExpired:
                raise HTTPException(504, "clip extraction timed out")
            except subprocess.CalledProcessError as exc:
                log.warning("clip extraction failed: %s", exc.stderr[-400:] if exc.stderr else exc)
                raise HTTPException(500, f"clip extraction failed: {shlex.quote(str(exc))[-200:]}")

    return FileResponse(cache_path, media_type="video/mp4")


@router.delete("/api/events")
def clear_events(request: Request):
    """Wipe the in-memory event buffer.

    HTTP: DELETE /api/events
    AUTH: admin bearer
    Returns: ``{"cleared": <n>}`` — count of events removed.
    """
    require_admin(request, "clear events")
    cleared = state.clear_recent_events()
    audit.log("clear_events", "recent_events", outcome="success")
    return {"cleared": cleared}
