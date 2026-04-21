"""AI-agent routes (coaching / investigation / report).

Each agent is a bounded-tool LLM loop (see ``services/agents.py``). Tool sets
are capped at 5 to avoid tool-overload hallucination — do not widen past
that cap without a specific reason.

All three endpoints are ``async def`` because they await an LLM call,
which is I/O bound. ``async`` lets FastAPI serve other requests while
one of these is waiting on the model provider.

UI connection
-------------
Page: None (operator-only endpoints, not currently called by the React frontend).
UI element: No direct UI — invoked out-of-band by an operator (e.g. via curl)
to generate AI coaching notes / investigations / session reports for review.
Backend route(s): POST /api/agents/coaching, POST /api/agents/investigation,
POST /api/agents/report.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.compliance import audit
from backend.services.agents import (
    run_coaching_agent,
    run_investigation_agent,
    run_report_agent,
)
from backend.state import state

# ``APIRouter`` is FastAPI's way of grouping related routes — the main
# app later does ``app.include_router(router)`` to attach them.
router = APIRouter()


class EventIdBody(BaseModel):
    """Request body for endpoints that operate on a single event.

    Pydantic validates ``event_id`` is present (``...`` means required),
    is at least 1 and at most 200 characters. Empty / oversized ids are
    rejected with a 422 before the handler runs.
    """

    event_id: str = Field(..., min_length=1, max_length=200)


# ``@router.post(...)`` — decorator registering the function below as the
# handler for HTTP POST to that path. The ``body: EventIdBody`` type hint
# tells FastAPI: parse the request JSON into an EventIdBody instance.
@router.post("/api/agents/coaching")
async def api_agent_coaching(body: EventIdBody):
    """Generate an AI coaching note for a specific event.

    HTTP: POST /api/agents/coaching
    Request body: ``{"event_id": "<id>"}``
    Returns: agent result dict (narrative + metadata).
    Raises:
        400 when event_id is blank after stripping.
        503 when the agent executor hasn't been wired up yet (startup race).
    """
    event_id = body.event_id.strip()
    if not event_id:
        # ``HTTPException`` is how FastAPI handlers signal a non-2xx
        # response. 400 = client error, malformed input.
        raise HTTPException(400, "missing 'event_id'")
    if state.agent_executor is None:
        # 503 = service unavailable: the agent infra isn't initialised.
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_coaching", event_id)
    # ``await`` hands control back to the event loop while the LLM runs;
    # the server can process other requests meanwhile.
    result = await run_coaching_agent(state.agent_executor, event_id)
    return result.as_dict()


@router.post("/api/agents/investigation")
async def api_agent_investigation(body: EventIdBody):
    """Run an AI investigation on a specific event.

    HTTP: POST /api/agents/investigation
    Request body: ``{"event_id": "<id>"}``
    Returns: agent result dict (findings + tool trace).
    Raises:
        400 when event_id is blank after stripping.
        503 when the agent executor hasn't been wired up yet.
    """
    event_id = body.event_id.strip()
    if not event_id:
        raise HTTPException(400, "missing 'event_id'")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_investigation", event_id)
    result = await run_investigation_agent(state.agent_executor, event_id)
    return result.as_dict()


@router.post("/api/agents/report")
async def api_agent_report():
    """Generate an AI safety summary report for the current session.

    HTTP: POST /api/agents/report
    Takes no request body — operates on the current in-memory event buffer.
    Raises: 503 when the agent executor is not ready.
    """
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_report", "session_report")
    result = await run_report_agent(state.agent_executor)
    return result.as_dict()
