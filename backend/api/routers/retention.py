"""Data-retention control routes (manual sweep trigger)."""

from fastapi import APIRouter

from backend.compliance import audit
from backend.compliance.retention import run_sweep as retention_sweep

router = APIRouter()


@router.post("/api/retention/sweep")
def api_retention_sweep():
    """Trigger an immediate retention sweep (normally runs hourly).

    HTTP: POST /api/retention/sweep
    Returns: dict summarising files deleted by the sweep.
    """
    audit.log("retention_sweep", "manual_trigger")
    return retention_sweep()
