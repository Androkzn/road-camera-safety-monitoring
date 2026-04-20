"""LLM observability routes (stats + recent calls)."""

from fastapi import APIRouter

from backend.services.llm_obs import observer as llm_observer

router = APIRouter()


@router.get("/api/llm/stats")
def llm_stats(window_sec: float | None = None):
    """Aggregated LLM usage: cost, latency percentiles, error/skip rates.

    HTTP: GET /api/llm/stats
    Query params:
        window_sec: Optional rolling window. Defaults to observer's config.
    """
    return llm_observer.stats(window_sec)


@router.get("/api/llm/recent")
def llm_recent(limit: int = 50):
    """Raw recent LLM call records for debugging.

    HTTP: GET /api/llm/recent
    Query params:
        limit: Max records (capped at 200 server-side).
    """
    return {"items": llm_observer.recent(min(limit, 200))}
