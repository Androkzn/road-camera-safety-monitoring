"""AI-agent routes (coaching / investigation / report).

Each agent is a bounded-tool LLM loop (see ``services/agents.py``). Tool sets
are capped at 5 to avoid tool-overload hallucination — do not widen past
that cap without a specific reason.
"""

from fastapi import APIRouter, HTTPException, Request

from road_safety.compliance import audit
from road_safety.security.auth import require_admin
from road_safety.services.agents import (
    run_coaching_agent,
    run_investigation_agent,
    run_report_agent,
)
from road_safety.state import state

router = APIRouter()


@router.post("/api/agents/coaching")
async def api_agent_coaching(request: Request, body: dict):
    """Generate an AI coaching note for a specific event.

    HTTP: POST /api/agents/coaching
    AUTH: admin bearer
    Request body: ``{"event_id": "<id>"}``
    Returns: agent result dict (narrative + metadata).
    """
    require_admin(request, "agent coaching")
    event_id = (body.get("event_id") or "").strip()
    if not event_id:
        raise HTTPException(400, "missing 'event_id'")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_coaching", event_id)
    result = await run_coaching_agent(state.agent_executor, event_id)
    return result.as_dict()


@router.post("/api/agents/investigation")
async def api_agent_investigation(request: Request, body: dict):
    """Run an AI investigation on a specific event.

    HTTP: POST /api/agents/investigation
    AUTH: admin bearer
    Request body: ``{"event_id": "<id>"}``
    """
    require_admin(request, "agent investigation")
    event_id = (body.get("event_id") or "").strip()
    if not event_id:
        raise HTTPException(400, "missing 'event_id'")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_investigation", event_id)
    result = await run_investigation_agent(state.agent_executor, event_id)
    return result.as_dict()


@router.post("/api/agents/report")
async def api_agent_report(request: Request):
    """Generate an AI safety summary report for the current session.

    HTTP: POST /api/agents/report
    AUTH: admin bearer
    """
    require_admin(request, "agent report")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_report", "session_report")
    result = await run_report_agent(state.agent_executor)
    return result.as_dict()
