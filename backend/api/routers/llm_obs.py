"""LLM observability routes (stats + recent calls).

Exposes two read-only endpoints on top of the in-process ``llm_observer``
so operators can eyeball cost / latency / error rates without a separate
metrics backend.

UI connection
-------------
Page: None (operator-only debugging endpoints, not surfaced in the React frontend).
UI element: No direct UI — operators hit these endpoints directly to check
LLM cost / latency / error rates. Referenced in tooltip copy on the
Settings page (`/api/llm/stats`) but not actually fetched there.
Backend route(s): GET /api/llm/stats, GET /api/llm/recent.
"""

from fastapi import APIRouter

from backend.services.llm_obs import observer as llm_observer

# ``APIRouter`` = FastAPI's route-grouping primitive.
router = APIRouter()


# ``@router.get("/...")`` registers the function as an HTTP GET handler.
# Type hints on parameters (``window_sec: float | None = None``) tell
# FastAPI: "this is a QUERY-STRING parameter, parse it as float, default
# to None". No Pydantic model needed for simple scalars.
@router.get("/api/llm/stats")
def llm_stats(window_sec: float | None = None):
    """Aggregated LLM usage: cost, latency percentiles, error/skip rates.

    HTTP: GET /api/llm/stats[?window_sec=<float>]
    Query params:
        window_sec: Optional rolling window. Defaults to observer's config.
    """
    return llm_observer.stats(window_sec)


@router.get("/api/llm/recent")
def llm_recent(limit: int = 50):
    """Raw recent LLM call records for debugging.

    HTTP: GET /api/llm/recent[?limit=<int>]
    Query params:
        limit: Max records (capped at 200 server-side to prevent abuse).
    """
    return {"items": llm_observer.recent(min(limit, 200))}
