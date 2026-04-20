"""Audit-log routes for compliance review."""

from fastapi import APIRouter

from backend.compliance import audit

router = APIRouter()


@router.get("/api/audit")
def api_audit(limit: int = 100):
    """Tail of the audit log for compliance review.

    HTTP: GET /api/audit
    Query params:
        limit: Max records (capped at 500 server-side).
    """
    return {"items": audit.tail(min(limit, 500))}


@router.get("/api/audit/stats")
def api_audit_stats():
    """Aggregate audit counters (actions, outcomes).

    HTTP: GET /api/audit/stats
    """
    return audit.stats()
