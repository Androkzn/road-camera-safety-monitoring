"""LLM observability routes (stats + recent calls).

Exposes two read-only endpoints on top of the in-process ``llm_observer``
(``backend.services.llm_obs``) so operators can eyeball cost / latency /
error rates without a separate metrics backend. The observer itself is
updated every time ``backend.services.llm`` makes a provider call, so
these routes reflect whatever work the enrichment layer is doing right now.

UI connection
-------------
Page: None (operator-only debugging endpoints, not surfaced in the React frontend).
UI element: No direct UI — operators hit these endpoints directly to check
LLM cost / latency / error rates. Referenced in tooltip copy on the
Settings page (``frontend/src/features/settings/constants.ts`` mentions
``/api/llm/stats`` in a throttling-mode explainer string) but not
actually fetched by any React hook.
Backend route(s): GET /api/llm/stats, GET /api/llm/recent.
Backend services used: ``backend.services.llm_obs.observer`` (in-process
rolling aggregator populated by every call made through
``backend.services.llm``).
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
    Returns: dict with cost totals, p50/p95 latency, error counts, skip
        reasons (rate-budget / circuit-breaker) — exactly what
        ``llm_observer.stats()`` emits.
    FE caller: none directly.
    Side effects: none (read-only).
    """
    return llm_observer.stats(window_sec)


@router.get("/api/llm/recent")
def llm_recent(limit: int = 50):
    """Raw recent LLM call records for debugging.

    HTTP: GET /api/llm/recent[?limit=<int>]
    Query params:
        limit: Max records (clamped at 200 server-side so a caller can't
            force the observer to serialise its entire ring buffer).
    Returns: ``{"items": [call_record, ...]}`` — newest last; each record
        carries provider, model, latency, cost, and outcome.
    FE caller: none directly.
    Side effects: none (read-only).
    """
    return {"items": llm_observer.recent(min(limit, 200))}
