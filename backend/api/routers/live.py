"""Live status / perception / scene / drift / events routes.

These are the "read the live pipeline state" endpoints used by the
operator UI: header status bar, event list, per-event detail, event
clip download, and the drift + perception panels.

Every handler in this file is synchronous (``def``, not ``async def``)
because it only reads in-memory state — no I/O to await. FastAPI still
runs them without blocking: sync handlers are dispatched to a thread
pool automatically.

NOTE: the SSE live event feed (``/api/events/stream``) and the
source-registry CRUD routes (``/api/live/sources``) are NOT in this
file — they live in their own routers. This module owns only the
read-only "what is the pipeline doing right now?" endpoints.

UI connection
-------------
Pages: ``DashboardPage`` (frontend/src/features/dashboard/DashboardPage.tsx),
``AdminPage`` (frontend/src/features/admin/AdminPage.tsx), plus the
``EventDialog`` opened from any event card.

FE hooks / components that consume each route (verified against
``frontend/src/**``):

- ``GET /api/live/status`` → ``useLiveStatus``
  (``frontend/src/shared/hooks/useLiveStatus.ts``). Drives the ``TopBar``
  connection strip and the ``HealthStrip`` on AdminPage.
- ``GET /api/live/scene`` → ``useScene``
  (``frontend/src/features/dashboard/hooks/useScene.ts``) via
  ``dashboardApi.getScene`` (``frontend/src/features/dashboard/api.ts``).
- ``GET /api/drift`` → ``dashboardApi.getDrift``
  (``frontend/src/features/dashboard/api.ts``); drives the dashboard
  drift banner.
- ``GET /api/live/events`` → ``useHistory``
  (``frontend/src/features/admin/hooks/useHistory.ts``) via
  ``adminApi.getLiveEvents`` (``frontend/src/features/admin/api.ts``).
- ``GET /api/events/{id}/clip`` → ``EventDialog``
  (``frontend/src/shared/events/EventDialog.tsx``).
- ``GET /api/live/perception`` — currently server-side / debug only;
  the perception block surfaced in the UI is already embedded inside
  the ``/api/live/status`` response consumed by ``useLiveStatus``.
- ``GET /api/events``, ``GET /api/events/{id}``, ``DELETE /api/events``
  — used by operator tooling / tests; no React hook calls them directly
  (the live feed ``useEventStream`` / ``EventStreamProvider`` speaks to
  the separate SSE route ``/api/events/stream``).

Backend route(s): GET /api/live/status, GET /api/live/perception,
GET /api/live/scene, GET /api/drift, GET /api/live/events, GET /api/events,
GET /api/events/{event_id}, GET /api/events/{event_id}/clip,
DELETE /api/events.

Backend services used: ``backend.state`` (in-memory perception snapshot
+ recent-events ring), ``backend.compliance.audit`` (audit trail on
event-buffer wipe), ``backend.services.llm`` / ``backend.integrations.slack``
(``*_configured`` probes surfaced on status), ``backend.rendering.clip``
(annotated MP4 renderer), ``backend.security.rate_limit`` (per-IP clip
render guard).
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from backend.api.models import EventModel, LiveStatusResponse
from backend.compliance import audit
from backend.config import (
    ALPR_MODE,
    DATA_DIR,
    LOCATION,
    TARGET_FPS,
)
from backend.integrations.slack import slack_configured
from backend.logging import get_logger
from backend.rendering.clip import render_annotated_event_clip
from backend.security.rate_limit import clip_rate_limit_check
from backend.services.llm import llm_configured
from backend.state import StreamSlot, state


def _resolve_slot(source_id: str | None) -> StreamSlot:
    """Return the slot for ``source_id`` or raise 404.

    Centralises the two-line pattern used by every ``?source_id=`` route —
    mypy flagged the old inline version for rebinding a variable from
    ``StreamSlot`` to ``StreamSlot | None`` across branches. Extracting
    this helper gives us one return path with a single concrete type.
    """
    if source_id is None:
        return state.primary_slot
    resolved = state.slots.get(source_id)
    if resolved is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    return resolved

log = get_logger(__name__)

# ``APIRouter`` — route grouping container that ``server.py`` mounts.
router = APIRouter()


# ``response_model=LiveStatusResponse`` validates + filters the returned
# dict through a pydantic model. That shapes the OpenAPI schema for /docs
# and guarantees the frontend contract.
@router.get("/api/live/status", response_model=LiveStatusResponse)
def live_status():
    """Public health + configuration snapshot for the operator UI.

    HTTP: GET /api/live/status
    Response: a large dict with source label, running flag, frame counts,
        uptime, tracker/risk-model names, and PII-redaction config.
        Shape is validated by the ``LiveStatusResponse`` pydantic model
        (codegenned to the TS ``LiveStatus`` type in
        ``frontend/src/shared/types/generated.ts``).
    FE caller: ``useLiveStatus`` (``frontend/src/shared/hooks/useLiveStatus.ts``)
        polls this on an interval; the result feeds ``TopBar`` on every
        page and ``HealthStrip`` on AdminPage.
    Side effects: none (read-only snapshot).

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
    Query params:
        source_id: optional; defaults to the primary slot when omitted.
    Response: ``QualityMonitor.state()`` dict (state label, reason,
        samples, since_sec, avg_confidence, luminance, sharpness).
    FE caller: none directly — the same block is embedded inside
        ``/api/live/status`` and surfaced through ``useLiveStatus``.
        This route is kept for debugging / scripted per-slot inspection.
    Side effects: none.
    Raises: 404 when ``source_id`` is given but unknown.
"""
    slot = _resolve_slot(source_id)
    return slot.quality.state()


@router.get("/api/live/scene")
def live_scene(source_id: str | None = None):
    """Current scene context + adaptive thresholds.

    HTTP: GET /api/live/scene[?source_id=<slot>]
    Query params:
        source_id: optional; defaults to the primary slot when omitted.
    Returns: label (urban/highway/parking), confidence, ego-flow proxy,
        and the active risk thresholds that were rescaled for that scene
        (matches the ``SceneContext`` TS type in
        ``frontend/src/shared/types/generated.ts``).
    FE caller: ``useScene`` (``frontend/src/features/dashboard/hooks/useScene.ts``)
        via ``dashboardApi.getScene`` — drives the dashboard scene banner.
    Side effects: none.
    Raises: 404 when ``source_id`` is given but unknown.
"""
    slot = _resolve_slot(source_id)
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
    """Rolling precision report — tracks whether operator-labelled true/false
    positives are trending over time.

    HTTP: GET /api/drift
    Returns: ``DriftReport`` dict (see generated.ts).
    FE caller: ``dashboardApi.getDrift``
        (``frontend/src/features/dashboard/api.ts``) — drives the
        dashboard drift banner.
    Side effects: none.
"""
    return state.drift.compute().as_dict()


# ``response_model=list[EventModel]`` — FastAPI validates the return value
# is a list of events matching ``EventModel`` and uses that in OpenAPI.
@router.get("/api/live/events", response_model=list[EventModel])
def live_events(risk_level: str | None = None, event_type: str | None = None, limit: int = 100):
    """Paginated read of live events with optional filters.

    HTTP: GET /api/live/events[?risk_level=high&event_type=...&limit=100]
    Query params:
        risk_level: optional exact match ("high" / "medium" / "low").
        event_type: optional event-type filter.
        limit: max records returned (slice of the most recent).
    Returns: ``list[EventModel]`` — same shape as SSE ``SafetyEvent``
        frames, already stripped of raw plate text by ``enrich_event``.
    FE caller: ``useHistory``
        (``frontend/src/features/admin/hooks/useHistory.ts``) via
        ``adminApi.getLiveEvents`` — drives the AdminPage history panel.
    Side effects: none.
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
    Query params:
        risk_level: optional exact match ("high" / "medium" / "low").
        event_type: optional event-type filter.
        limit: max records returned (default 500; slice of the most recent).
    Returns: ``list[EventModel]``.
    FE caller: none directly — the React app reads live events over SSE
        via ``useEventStream`` / ``EventStreamProvider`` and backfills
        through ``/api/events/history`` (both live in different routers).
        This route is retained for operator tooling / tests.
    Side effects: none.

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
    Path params:
        event_id: the opaque event id emitted by the perception pipeline.
    Returns: ``EventModel``.
    FE caller: none directly; event cards already carry the full payload
        they were rendered with. Kept for scripted / operator lookup.
    Side effects: none.
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
    Path params:
        event_id: the event to clip around.
    Query params:
        before/after: seconds of context to include (allowed values only —
            see ``_CLIP_WINDOW_ALLOWED``; bounding the set prevents
            operators requesting huge arbitrary windows that would
            balloon ffmpeg CPU + disk cache).
        annotated: when True, draw bounding boxes over the clip.
    Returns: ``FileResponse`` (video/mp4). First call for a given
        (event,before,after,annotated) tuple renders + caches under
        ``DATA_DIR/clips/``; later calls are served from cache.
    FE caller: ``EventDialog``
        (``frontend/src/shared/events/EventDialog.tsx``) — the <video>
        element opens this URL when the user clicks an event card.
    Side effects:
        - Writes an MP4 into ``DATA_DIR/clips/`` on cache miss.
        - On annotated cache-miss path, consumes one token from the
          per-IP clip-render rate limiter.
    Raises:
        400 on disallowed before/after values.
        404 when the event or its source file cannot be located.
        500 / 504 on ffmpeg failure / timeout.
    """
    import shlex
    import subprocess

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

    # Clamp the seek point to 0 so we never pass a negative -ss to ffmpeg
    # when the event is within ``before`` seconds of the source's start.
    start = max(0.0, float(ts_sec) - before)
    duration = before + after

    # Cache path is keyed by (event, window, annotated) so different
    # callers asking for different windows don't clobber each other.
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
                # Annotated render blew up (e.g. OpenCV issue) — fall back
                # to a plain ffmpeg cut so the user at least gets video
                # instead of a 500. Swap to the non-annotated cache key.
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
def clear_events():
    """Wipe the in-memory event buffer.

    HTTP: DELETE /api/events
    Returns: ``{"cleared": <n>}`` — count of events removed.
    FE caller: none directly — operator/test affordance, typically hit
        via curl or a test fixture.
    Side effects:
        - Drops every event from the in-memory recent-events ring.
        - Writes an ``audit.log("clear_events", ...)`` entry so a
          compliance reviewer can see who wiped the buffer and when.
    """
    cleared = state.clear_recent_events()
    audit.log("clear_events", "recent_events", outcome="success")
    return {"cleared": cleared}
