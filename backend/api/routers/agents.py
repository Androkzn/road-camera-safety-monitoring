"""AI-agent routes (coaching / investigation / report).

Each agent is a bounded-tool LLM loop (see ``services/agents.py``). Tool sets
are capped at 5 to avoid tool-overload hallucination — do not widen past
that cap without a specific reason.
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

router = APIRouter()


class EventIdBody(BaseModel):
    event_id: str = Field(..., min_length=1, max_length=200)


@router.post("/api/agents/coaching")
async def api_agent_coaching(body: EventIdBody):
    """Generate an AI coaching note for a specific event.

    HTTP: POST /api/agents/coaching
    Request body: ``{"event_id": "<id>"}``
    Returns: agent result dict (narrative + metadata).
    """
    event_id = body.event_id.strip()
    if not event_id:
        raise HTTPException(400, "missing 'event_id'")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_coaching", event_id)
    result = await run_coaching_agent(state.agent_executor, event_id)
    return result.as_dict()


@router.post("/api/agents/investigation")
async def api_agent_investigation(body: EventIdBody):
    """Run an AI investigation on a specific event.

    HTTP: POST /api/agents/investigation
    Request body: ``{"event_id": "<id>"}``
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
    """
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_report", "session_report")
    result = await run_report_agent(state.agent_executor)
    return result.as_dict()
