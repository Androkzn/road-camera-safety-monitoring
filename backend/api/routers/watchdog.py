"""Watchdog + shadow-validator control routes.

The "watchdog" groups repeated errors into fingerprinted incidents. The
"shadow validator" is a background worker that cross-checks events
against a secondary model. Both are controlled here.

UI connection
-------------
Page: MonitoringPage — [file](frontend/src/features/watchdog/components/WatchdogDrawer.tsx)
       (the watchdog badge + drawer is also mounted on every page header)
       and ValidationPage — [file](frontend/src/features/validation/components/ValidatorControl.tsx).
UI element: the watchdog badge in the page header (with the incident drawer
that lists each finding and a delete button), plus the "shadow validator"
on/off toggle card on the Validation page.
Backend route(s): GET /api/watchdog, GET /api/watchdog/recent,
DELETE /api/watchdog/findings, POST /api/watchdog/findings/delete,
GET /api/validator/status, POST /api/validator/toggle.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.logging import get_logger
from backend.services.watchdog import (
    delete_findings as watchdog_delete,
    delete_findings_by_id as watchdog_delete_by_id,
    tail as watchdog_tail,
)
from backend.state import state

log = get_logger(__name__)

# ``APIRouter`` — the container we attach every handler below to.
router = APIRouter()


class ValidatorToggleBody(BaseModel):
    """POST body for /api/validator/toggle — single ``enabled`` flag."""

    enabled: bool = True


class DeleteFindingsBody(BaseModel):
    """POST body listing findings to delete by composite-key string.

    ``Field(default_factory=list)`` creates a fresh empty list per
    instance — never share a single list default across instances.
    """

    keys: list[str] = Field(default_factory=list)


@router.get("/api/watchdog")
def watchdog_summary():
    """Watchdog status and finding counts.

    HTTP: GET /api/watchdog
    Returns: ``{"enabled": False}`` if the watchdog is not wired up,
        else status dict with counts + last-seen timestamps.
    """
    if state.watchdog is None:
        return {"enabled": False}
    return state.watchdog.status()


@router.get("/api/validator/status")
def validator_status():
    """Background shadow-validator worker status.

    HTTP: GET /api/validator/status
    Returns: enabled flag plus queue depth / last-run details.
    """
    if state.validator is None:
        return {"enabled": False}
    # ``**state.validator.status()`` spreads the dict into this literal —
    # equivalent to ``{"enabled": True, "k1": v1, "k2": v2, ...}``.
    return {"enabled": True, **state.validator.status()}


@router.post("/api/validator/toggle")
async def validator_toggle(body: ValidatorToggleBody):
    """Enable or disable the shadow validator at runtime.

    HTTP: POST /api/validator/toggle
    Request body: ``{"enabled": true|false}``
    Raises: 409 when the validator was disabled at startup (requires an
        env-var-driven restart to appear).
    """
    if state.validator is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "validator was disabled at startup; set ROAD_VALIDATOR_ENABLED=1 "
                "and restart to enable runtime toggling"
            ),
        )
    enabled = bool(body.enabled)
    state.validator.set_paused(not enabled)
    log.info("validator %s by operator", "resumed" if enabled else "paused")
    return {"enabled": True, **state.validator.status()}


@router.get("/api/watchdog/recent")
def watchdog_recent(n: int = 50):
    """Most recent watchdog findings.

    HTTP: GET /api/watchdog/recent[?n=<int>]
    Query params:
        n: Max records (capped at 200 server-side).
    """
    return watchdog_tail(min(n, 200))


@router.delete("/api/watchdog/findings")
def watchdog_delete_findings(clear_all: bool = False):
    """Delete specific findings by composite key or clear all.

    HTTP: DELETE /api/watchdog/findings[?clear_all=true]
    Only the ``clear_all=true`` branch is active here; selective delete
    is handled by the sibling POST endpoint below (which takes a JSON
    body of keys).
    """
    if clear_all:
        removed = watchdog_delete(indices=None)
        return {"deleted": removed}
    return {"deleted": 0}


@router.post("/api/watchdog/findings/delete")
async def watchdog_delete_selected(body: DeleteFindingsBody):
    """Delete selected findings by snapshot_id + ts composite keys.

    HTTP: POST /api/watchdog/findings/delete
    Request body: ``{"keys": ["<snapshot_id>:<ts>", ...]}``
    Returns: ``{"deleted": <count>}``.
    """
    keys = list(body.keys)
    if not keys:
        return {"deleted": 0}
    removed = watchdog_delete_by_id(keys)
    return {"deleted": removed}
