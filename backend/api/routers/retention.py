"""Data-retention control routes (manual sweep trigger)."""

from fastapi import APIRouter, Request

from backend.compliance import audit
from backend.compliance.retention import run_sweep as retention_sweep
from backend.security.auth import require_admin

router = APIRouter()


@router.post("/api/retention/sweep")
def api_retention_sweep(request: Request):
    """Trigger an immediate retention sweep (normally runs hourly).

    HTTP: POST /api/retention/sweep
    AUTH: admin bearer
    Returns: dict summarising files deleted by the sweep.
    """
    require_admin(request, "retention control")
    audit.log("retention_sweep", "manual_trigger")
    return retention_sweep()
