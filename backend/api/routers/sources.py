"""Multi-source stream lifecycle routes.

CRUD on ``state.slots`` + per-slot start / pause / restart-all / detection-toggle.
"""

import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.api.models import LiveSourcesResponse
from backend.compliance import audit
from backend.logging import get_logger
from backend.perception.slot_control import (
    pause_slot,
    resume_slot,
    start_slot,
    stop_slot,
)
from backend.security.ssrf import validate_public_url
from backend.state import StreamSlot, state

log = get_logger(__name__)

router = APIRouter()


class AddSourceBody(BaseModel):
    url: str = Field(..., min_length=1, max_length=2000)
    name: str | None = Field(default=None, max_length=200)
    id: str | None = Field(default=None, max_length=100)
    autostart: bool = True


@router.get("/api/live/sources", response_model=LiveSourcesResponse)
def live_sources():
    """List every configured source with running status + counters.

    HTTP: GET /api/live/sources
    """
    return {
        "primary_id": state.PRIMARY_ID,
        "sources": [slot.status_dict() for slot in state.slots.values()],
    }


@router.post("/api/live/sources/{source_id}/start")
def live_source_start(source_id: str):
    """Resume capture for a paused source.

    HTTP: POST /api/live/sources/{source_id}/start
    """
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    if slot.is_running():
        return {"ok": True, "already_running": True, **slot.status_dict()}
    if resume_slot(slot):
        audit.log("stream_resume", source_id)
        return {"ok": True, "resumed": True, **slot.status_dict()}
    try:
        start_slot(slot)
    except Exception as exc:
        slot.last_error = str(exc)
        log.warning("start slot %s failed: %s", source_id, exc)
        return {"ok": False, "error": str(exc), **slot.status_dict()}
    audit.log("stream_start", source_id)
    return {"ok": True, **slot.status_dict()}


@router.post("/api/live/sources/{source_id}/pause")
def live_source_pause(source_id: str):
    """Pause capture for a running source (slot is preserved for restart).

    HTTP: POST /api/live/sources/{source_id}/pause
    """
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    if not pause_slot(slot):
        pass
    audit.log("stream_pause", source_id)
    return {"ok": True, **slot.status_dict()}


def _slugify_id(seed: str) -> str:
    """Build a short, URL-safe id from a seed string (e.g. a YouTube URL).

    Used when the operator adds a stream without supplying an explicit id.
    """
    keep = "".join(c for c in seed if c.isalnum())
    if not keep:
        keep = "stream"
    return f"user_{keep[-12:].lower()}"


def _unique_slot_id(seed: str) -> str:
    """Return ``_slugify_id(seed)`` adjusted with a numeric suffix if needed."""
    base = _slugify_id(seed)
    if base not in state.slots:
        return base
    for n in range(2, 100):
        cand = f"{base}_{n}"
        if cand not in state.slots:
            return cand
    return f"{base}_{int(time.time() * 1000)}"


@router.post("/api/live/sources")
async def live_source_add(body: AddSourceBody):
    """Register a new perception source from a URL the operator pastes.

    HTTP: POST /api/live/sources
    Body (JSON): ``{"url": "<stream url>", "name"?: "<display name>",
                   "id"?: "<explicit slot id>", "autostart"?: bool}``
    SSRF-guarded.
    """
    url = body.url.strip()
    if not url:
        raise HTTPException(400, "missing 'url'")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "url must start with http:// or https://")

    # BE-D15: reject URLs that resolve to private / loopback / link-local /
    # metadata addresses.
    validate_public_url(url)

    requested_id = (body.id or "").strip()
    if requested_id:
        if requested_id in state.slots:
            raise HTTPException(409, f"id already in use: {requested_id}")
        sid = requested_id
    else:
        sid = _unique_slot_id(url)

    name = (body.name or "").strip() or f"Custom ({sid})"
    autostart = bool(body.autostart)

    slot = StreamSlot(sid, name, url)
    state.slots[sid] = slot
    audit.log("stream_add", sid, detail={"url": url[:200], "name": name})

    if autostart:
        try:
            start_slot(slot)
        except Exception as exc:
            slot.last_error = str(exc)
            log.warning("autostart of %s failed: %s", sid, exc)
            return {"ok": False, "error": str(exc), **slot.status_dict()}

    return {"ok": True, **slot.status_dict()}


@router.delete("/api/live/sources/{source_id}")
def live_source_remove(source_id: str):
    """Stop the slot and drop it from the registry.

    HTTP: DELETE /api/live/sources/{source_id}
    """
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    stop_slot(slot)
    state.slots.pop(source_id, None)
    audit.log("stream_remove", source_id)
    return {"ok": True, "removed": source_id}


@router.post("/api/live/sources/{source_id}/detection")
def live_source_set_detection(source_id: str, enabled: bool = True):
    """Toggle whether YOLO + event emission runs for a source.

    HTTP: POST /api/live/sources/{source_id}/detection?enabled=true|false
    """
    slot = state.slots.get(source_id)
    if slot is None:
        raise HTTPException(404, f"unknown source: {source_id}")
    slot.detection_enabled = bool(enabled)
    audit.log(
        "stream_detection_enabled" if slot.detection_enabled else "stream_detection_disabled",
        source_id,
    )
    return {"ok": True, **slot.status_dict()}
