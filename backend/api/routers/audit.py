"""Audit-log routes for compliance review.

Every sensitive operation (event access, agent run, settings change…) is
written to the audit log by ``backend.compliance.audit``. This router
exposes two read-only views over that log.

UI connection
-------------
Page: None (compliance-reviewer endpoint, not surfaced in the React frontend).
UI element: No direct UI — a compliance reviewer hits these endpoints
directly (curl / browser) to read the audit log and aggregate counters.
A grep of ``frontend/src/**`` confirms neither ``/api/audit`` nor
``/api/audit/stats`` is fetched by any React component or hook; every
write path calls ``audit.log(...)`` directly on the server side.
Backend route(s): GET /api/audit, GET /api/audit/stats.
Backend services used: ``backend.compliance.audit`` (JSONL tail reader
and counter aggregator).
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
        limit: Max records (capped at 500 server-side to bound payload —
            the client-supplied value is clamped before it reaches the
            JSONL reader so a curious caller can't pull the whole file).
    Returns: ``{"items": [audit_record, ...]}`` — newest last.
    FE caller: none.
    Side effects: none (read-only).
    """
    return {"items": audit.tail(min(limit, 500))}


@router.get("/api/audit/stats")
def api_audit_stats():
    """Aggregate audit counters (actions, outcomes).

    HTTP: GET /api/audit/stats
    Returns: counts grouped by action name and outcome (success/denied/…),
        suitable for a compliance dashboard.
    FE caller: none.
    Side effects: none (read-only).
    """
    return audit.stats()
