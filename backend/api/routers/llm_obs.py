"""LLM observability routes (stats + recent calls)."""

from fastapi import APIRouter, Request

from backend.security.auth import require_admin
from backend.services.llm_obs import observer as llm_observer

router = APIRouter()


@router.get("/api/llm/stats")
def llm_stats(request: Request, window_sec: float | None = None):
    """Aggregated LLM usage: cost, latency percentiles, error/skip rates.

    HTTP: GET /api/llm/stats
    AUTH: admin bearer
    Query params:
        window_sec: Optional rolling window. Defaults to observer's config.
    """
    require_admin(request, "LLM observability")
    return llm_observer.stats(window_sec)


@router.get("/api/llm/recent")
def llm_recent(request: Request, limit: int = 50):
    """Raw recent LLM call records for debugging.

    HTTP: GET /api/llm/recent
    AUTH: admin bearer
    Query params:
        limit: Max records (capped at 200 server-side).
    """
    require_admin(request, "LLM observability")
    return {"items": llm_observer.recent(min(limit, 200))}
