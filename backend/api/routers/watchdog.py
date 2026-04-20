"""Watchdog + shadow-validator control routes."""

from fastapi import APIRouter, HTTPException, Request

from backend.config import ADMIN_TOKEN
from backend.logging import get_logger
from backend.security import require_bearer_token
from backend.security.auth import require_admin_if_flagged
from backend.services.watchdog import (
    delete_findings as watchdog_delete,
    delete_findings_by_id as watchdog_delete_by_id,
    tail as watchdog_tail,
)
from backend.state import state

log = get_logger(__name__)

router = APIRouter()


@router.get("/api/watchdog")
def watchdog_summary():
    """Watchdog status and finding counts.

    HTTP: GET /api/watchdog
    AUTH: public
    """
    if state.watchdog is None:
        return {"enabled": False}
    return state.watchdog.status()


@router.get("/api/validator/status")
def validator_status():
    """Background shadow-validator worker status.

    HTTP: GET /api/validator/status
    AUTH: public
    """
    if state.validator is None:
        return {"enabled": False}
    return {"enabled": True, **state.validator.status()}


@router.post("/api/validator/toggle")
async def validator_toggle(request: Request):
    """Enable or disable the shadow validator at runtime.

    HTTP: POST /api/validator/toggle
    AUTH: admin bearer (gated by ROAD_REQUIRE_AUTH — BE-D12).
    """
    require_admin_if_flagged(request, realm="validator toggle")
    if state.validator is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "validator was disabled at startup; set ROAD_VALIDATOR_ENABLED=1 "
                "and restart to enable runtime toggling"
            ),
        )
    body = await request.json()
    enabled = bool(body.get("enabled", True))
    state.validator.set_paused(not enabled)
    log.info("validator %s by operator", "resumed" if enabled else "paused")
    return {"enabled": True, **state.validator.status()}


@router.get("/api/watchdog/recent")
def watchdog_recent(n: int = 50):
    """Most recent watchdog findings.

    HTTP: GET /api/watchdog/recent
    AUTH: public
    """
    return watchdog_tail(min(n, 200))


@router.delete("/api/watchdog/findings")
def watchdog_delete_findings(request: Request, clear_all: bool = False):
    """Delete specific findings by composite key or clear all.

    HTTP: DELETE /api/watchdog/findings
    AUTH: admin Bearer (Settings Console S0 prereq hardening)
    """
    require_bearer_token(request, ADMIN_TOKEN, realm="watchdog", env_var="ROAD_ADMIN_TOKEN")
    if clear_all:
        removed = watchdog_delete(indices=None)
        return {"deleted": removed}
    return {"deleted": 0}


@router.post("/api/watchdog/findings/delete")
async def watchdog_delete_selected(request: Request):
    """Delete selected findings by snapshot_id + ts composite keys.

    HTTP: POST /api/watchdog/findings/delete
    AUTH: admin Bearer (Settings Console S0 prereq hardening)
    """
    require_bearer_token(request, ADMIN_TOKEN, realm="watchdog", env_var="ROAD_ADMIN_TOKEN")
    body = await request.json()
    keys: list[str] = body.get("keys", [])
    if not keys:
        return {"deleted": 0}
    removed = watchdog_delete_by_id(keys)
    return {"deleted": removed}
