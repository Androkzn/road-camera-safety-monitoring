"""Multi-source stream lifecycle routes.

CRUD on ``state.slots`` + per-slot start / pause / restart-all /
detection-toggle. Every mutation is audit-logged so a reviewer can
reconstruct which operator added / removed which source.

Endpoints
---------
* ``GET  /api/live/sources`` — list configured sources + status.
* ``POST /api/live/sources`` — add a new source (SSRF-guarded).
* ``POST /api/live/sources/{source_id}/start`` — start / resume.
* ``POST /api/live/sources/{source_id}/pause`` — pause (slot preserved).
* ``DELETE /api/live/sources/{source_id}`` — stop and drop slot.
* ``POST /api/live/sources/{source_id}/detection`` — toggle YOLO/emission.

UI connection
-------------
Page: AdminPage — [file](frontend/src/features/admin/AdminPage.tsx)
FE hooks that consume this router:
* ``useStreamRegistry`` (frontend/src/features/admin/hooks/useStreamRegistry.ts)
  — polls ``GET /api/live/sources`` to render the tile list.
* ``useStreamControl`` (frontend/src/features/admin/hooks/useStreamControl.ts)
  — calls the start/pause/delete/detection-toggle endpoints from each tile.
* ``useLiveSources`` / ``useLiveSourcesList`` for adjacent fleet views.
UI element: the source-management controls above the live video grid —
the "add stream URL" form, each tile's start / pause / remove buttons,
and the per-tile "detection on/off" toggle.

Backend services used
---------------------
* ``backend.perception.slot_control`` — ``start_slot`` / ``pause_slot`` /
  ``resume_slot`` / ``stop_slot`` drive the background capture threads.
* ``backend.security.ssrf.validate_public_url`` — SSRF guard on user URLs.
* ``backend.compliance.audit`` — every mutation is audit-logged.
* ``backend.state`` — ``state.slots`` is the shared slot registry.

Security notes
--------------
* POC has no request authentication on these mutating endpoints — any
  caller reachable on the network can add/remove sources. See CLAUDE.md
  "Access model" — add an auth layer before production.
* User-supplied URLs are SSRF-validated (see ``validate_public_url``) to
  reject loopback / private / link-local / cloud-metadata targets.
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

# ``APIRouter`` — holds every handler until ``server.py`` wires them in.
router = APIRouter()


class AddSourceBody(BaseModel):
    """Request body for POST /api/live/sources.

    ``url`` is required (``...``); ``name`` and ``id`` are optional and
    auto-generated when omitted; ``autostart`` defaults to True so the
    operator's typical "paste URL, press add" flow works in one step.
    """

    url: str = Field(..., min_length=1, max_length=2000)
    name: str | None = Field(default=None, max_length=200)
    id: str | None = Field(default=None, max_length=100)
    autostart: bool = True


@router.get("/api/live/sources", response_model=LiveSourcesResponse)
def live_sources():
    """List every configured source with running status + counters.

    HTTP: GET /api/live/sources
    Returns: a ``LiveSourcesResponse`` — ``primary_id`` plus a list of
        every slot's current status dict.
    """
    return {
        "primary_id": state.PRIMARY_ID,
        "sources": [slot.status_dict() for slot in state.slots.values()],
    }


@router.post("/api/live/sources/{source_id}/start")
def live_source_start(source_id: str):
    """Resume capture for a paused source, or start a stopped slot.

    HTTP: POST /api/live/sources/{source_id}/start
    Raises: 404 on unknown slot id.
    Returns: ``{"ok": True, ...status_dict}``. ``already_running`` /
        ``resumed`` flags indicate what path was taken.
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
    Raises: 404 on unknown slot id.
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
    SSRF-guarded: the URL is resolved and rejected if it points at
        private / loopback / link-local / cloud-metadata addresses.
    Raises:
        400 on invalid scheme / blank URL.
        409 when the requested id is already in use.
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
    Raises: 404 if the slot is not known.
    Returns: ``{"ok": True, "removed": <source_id>}``.
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
    ``enabled`` is a query-string parameter (not a body) because this
    is a simple flag toggle; no schema model required.
    Raises: 404 on unknown slot id.
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
