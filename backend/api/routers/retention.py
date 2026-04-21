"""Data-retention control routes (manual sweep trigger).

A "retention sweep" deletes thumbnails / events older than the
configured retention window. The sweep runs automatically every hour;
this router exposes a POST to force one immediately (useful during
testing or after a privacy-policy change).

UI connection
-------------
Page: None (operator-only endpoint, not surfaced in the React frontend).
UI element: No direct UI — an operator triggers the sweep manually after
changing a privacy policy, by hitting this endpoint directly.
Backend route(s): POST /api/retention/sweep.
"""

from fastapi import APIRouter

from backend.compliance import audit
from backend.compliance.retention import run_sweep as retention_sweep

# ``APIRouter`` — grouping container for the routes below.
router = APIRouter()


@router.post("/api/retention/sweep")
def api_retention_sweep():
    """Trigger an immediate retention sweep (normally runs hourly).

    HTTP: POST /api/retention/sweep
    Takes no body.
    Returns: dict summarising files deleted by the sweep.
    Side effects: writes an audit-log entry tagged ``manual_trigger``.
    """
    audit.log("retention_sweep", "manual_trigger")
    return retention_sweep()
