"""Audit-log routes for compliance review.

Every sensitive operation (event access, agent run, settings change…) is
written to the audit log by ``backend.compliance.audit``. This router
exposes two read-only views over that log.

UI connection
-------------
Page: None (compliance-reviewer endpoint, not surfaced in the React frontend).
UI element: No direct UI — a compliance reviewer hits these endpoints
directly (curl / browser) to read the audit log and aggregate counters.
Backend route(s): GET /api/audit, GET /api/audit/stats.
"""

from fastapi import APIRouter

from backend.compliance import audit

# ``APIRouter`` — holds both handlers below until ``server.py`` wires
# them into the FastAPI app.
router = APIRouter()


@router.get("/api/audit")
def api_audit(limit: int = 100):
    """Tail of the audit log for compliance review.

    HTTP: GET /api/audit[?limit=<int>]
    Query params:
        limit: Max records (capped at 500 server-side to bound payload).
    Returns: ``{"items": [audit_record, ...]}`` — newest last.
    """
    return {"items": audit.tail(min(limit, 500))}


@router.get("/api/audit/stats")
def api_audit_stats():
    """Aggregate audit counters (actions, outcomes).

    HTTP: GET /api/audit/stats
    Returns: counts grouped by action name and outcome (success/denied/…),
        for the compliance dashboard.
    """
    return audit.stats()
