"""Audit-log routes for compliance review."""

from fastapi import APIRouter, Request

from backend.compliance import audit
from backend.security.auth import require_admin

router = APIRouter()


@router.get("/api/audit")
def api_audit(request: Request, limit: int = 100):
    """Tail of the audit log for compliance review.

    HTTP: GET /api/audit
    AUTH: admin bearer
    Query params:
        limit: Max records (capped at 500 server-side).
    """
    require_admin(request, "audit log")
    return {"items": audit.tail(min(limit, 500))}


@router.get("/api/audit/stats")
def api_audit_stats(request: Request):
    """Aggregate audit counters (actions, outcomes).

    HTTP: GET /api/audit/stats
    AUTH: admin bearer
    """
    require_admin(request, "audit log")
    return audit.stats()
