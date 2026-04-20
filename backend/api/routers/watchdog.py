"""Watchdog + shadow-validator control routes."""

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

router = APIRouter()


class ValidatorToggleBody(BaseModel):
    enabled: bool = True


class DeleteFindingsBody(BaseModel):
    keys: list[str] = Field(default_factory=list)


@router.get("/api/watchdog")
def watchdog_summary():
    """Watchdog status and finding counts.

    HTTP: GET /api/watchdog
    """
    if state.watchdog is None:
        return {"enabled": False}
    return state.watchdog.status()


@router.get("/api/validator/status")
def validator_status():
    """Background shadow-validator worker status.

    HTTP: GET /api/validator/status
    """
    if state.validator is None:
        return {"enabled": False}
    return {"enabled": True, **state.validator.status()}


@router.post("/api/validator/toggle")
async def validator_toggle(body: ValidatorToggleBody):
    """Enable or disable the shadow validator at runtime.

    HTTP: POST /api/validator/toggle
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

    HTTP: GET /api/watchdog/recent
    """
    return watchdog_tail(min(n, 200))


@router.delete("/api/watchdog/findings")
def watchdog_delete_findings(clear_all: bool = False):
    """Delete specific findings by composite key or clear all.

    HTTP: DELETE /api/watchdog/findings
    """
    if clear_all:
        removed = watchdog_delete(indices=None)
        return {"deleted": removed}
    return {"deleted": 0}


@router.post("/api/watchdog/findings/delete")
async def watchdog_delete_selected(body: DeleteFindingsBody):
    """Delete selected findings by snapshot_id + ts composite keys.

    HTTP: POST /api/watchdog/findings/delete
    """
    keys = list(body.keys)
    if not keys:
        return {"deleted": 0}
    removed = watchdog_delete_by_id(keys)
    return {"deleted": removed}
