"""agents.py — tool-calling AI agents for coaching, investigation, reports.

What it does:
    Defines three Claude-powered agents that can call back into the
    system to gather information before answering:
      1. Coaching agent — given an event_id, writes a structured coaching
         note for the road-safety manager (what happened, why it matters,
         recommended action, policy reference).
      2. Investigation agent — correlates one event with similar recent
         events, operator feedback, and drift status to produce a root
         cause hypothesis.
      3. Report agent — builds a daily/weekly safety summary by counting
         events, consulting drift, and reviewing feedback.

Purpose:
    These are the "Ask Claude to think about it" flows exposed to
    operators. They go beyond single-prompt completions because the
    agent needs to look up events, load policy files, read feedback, etc.
    — that's what "tool calling" means.

How it works:
    * Each agent has a small, focused tool set (3-5 tools) to avoid
      tool-overload hallucination.
    * ``AgentExecutor.run`` implements the tool loop: send prompt + tools
      to Claude; if Claude returns a ``tool_use`` block, execute the
      matching Python function, attach the result as a ``tool_result``,
      and loop. Stops when Claude replies with plain text or after
      ``MAX_STEPS = 5`` iterations (safety guard against runaway loops).
    * ``async def`` / ``await`` let the agent pause for network calls
      without blocking the web server.
    * Output is a structured JSON object per agent (schema defined in
      each ``*_SYSTEM`` prompt) so the UI can render it as fields, not
      as free-form prose.
    * Tools are plain Python functions (``tool_get_event``,
      ``tool_get_recent_events``, ``tool_get_policy``,
      ``tool_get_feedback``, ``tool_get_drift_report``,
      ``tool_count_by_type``, ``tool_count_by_risk``); the executor
      dispatches by name.
    * Uses ``claude-haiku-4-5-20251001`` by default for speed + cost.

Connects to:
    - Backend: ``road_safety/server.py`` constructs an ``AgentExecutor``
      wired to the event buffer, recent-events source, and drift monitor;
      exposes ``/api/agents/coaching``, ``/api/agents/investigation``,
      and ``/api/agents/report`` (all POST). Uses
      ``road_safety.services.llm_obs.observer`` for metrics.
    - UI: none currently wired in ``frontend/src/lib/api.ts``; these
      endpoints are consumed manually or by future operator tooling.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from road_safety.config import CORPUS_DIR, DATA_DIR
from road_safety.services.llm_obs import observer as llm_observer
MAX_STEPS = 5


# ---------------------------------------------------------------------------
# Tool definitions — pure functions that agents can call
# ---------------------------------------------------------------------------

def tool_get_event(event_lookup: Callable, event_id: str) -> dict | None:
    """Retrieve a single event by ID from the live buffer."""
    return event_lookup(event_id)


def tool_get_recent_events(
    events_source: Callable,
    risk_level: str | None = None,
    event_type: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Query recent events with optional filters."""
    events = events_source() or []
    if risk_level:
        events = [e for e in events if e.get("risk_level") == risk_level]
    if event_type:
        events = [e for e in events if e.get("event_type") == event_type]
    return events[-limit:]


def tool_get_policy(filename: str | None = None) -> str:
    """Load road safety policy corpus documents."""
    if not CORPUS_DIR.exists():
        return "No policy corpus available."
    if filename:
        path = CORPUS_DIR / filename
        if path.exists() and path.is_file():
            return path.read_text(encoding="utf-8")
        return f"Policy file '{filename}' not found."
    chunks = []
    for p in sorted(CORPUS_DIR.glob("*.md")):
        try:
            chunks.append(f"=== {p.name} ===\n{p.read_text(encoding='utf-8')}")
        except Exception:
            pass
    return "\n\n".join(chunks) if chunks else "No policy documents found."


def tool_get_feedback(limit: int = 100) -> list[dict]:
    """Read recent operator feedback."""
    path = DATA_DIR / "feedback.jsonl"
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return out[-limit:]


def tool_get_drift_report(drift_monitor) -> dict:
    """Get current drift monitoring report."""
    try:
        return drift_monitor.compute().as_dict()
    except Exception:
        return {"error": "drift computation failed"}


def tool_count_by_type(events_source: Callable) -> dict[str, int]:
    """Count events by type for summary reporting."""
    events = events_source() or []
    counts: dict[str, int] = {}
    for e in events:
        t = e.get("event_type", "unknown")
        counts[t] = counts.get(t, 0) + 1
    return counts


def tool_count_by_risk(events_source: Callable) -> dict[str, int]:
    """Count events by risk level for summary reporting."""
    events = events_source() or []
    counts: dict[str, int] = {}
    for e in events:
        r = e.get("risk_level", "unknown")
        counts[r] = counts.get(r, 0) + 1
    return counts


# ---------------------------------------------------------------------------
# Tool schemas (for LLM function-calling)
# ---------------------------------------------------------------------------

COACHING_TOOLS = [
    {
        "name": "get_event",
        "description": "Retrieve a safety event by its event_id",
        "input_schema": {
            "type": "object",
            "properties": {"event_id": {"type": "string"}},
            "required": ["event_id"],
        },
    },
    {
        "name": "get_policy",
        "description": "Load road safety policy documents. Optionally specify a filename like 'road_policy.md'",
        "input_schema": {
            "type": "object",
            "properties": {"filename": {"type": "string"}},
            "required": [],
        },
    },
    {
        "name": "get_recent_events",
        "description": "Get recent events, optionally filtered by risk_level or event_type",
        "input_schema": {
            "type": "object",
            "properties": {
                "risk_level": {"type": "string", "enum": ["high", "medium", "low"]},
                "event_type": {"type": "string"},
                "limit": {"type": "integer", "default": 20},
            },
            "required": [],
        },
    },
]

INVESTIGATION_TOOLS = COACHING_TOOLS + [
    {
        "name": "get_feedback",
        "description": "Get recent operator feedback (tp/fp verdicts)",
        "input_schema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "default": 50}},
            "required": [],
        },
    },
    {
        "name": "get_drift_report",
        "description": "Get the current drift monitoring report with precision metrics",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
]

REPORT_TOOLS = [
    {
        "name": "get_recent_events",
        "description": "Get recent events, optionally filtered by risk_level or event_type",
        "input_schema": {
            "type": "object",
            "properties": {
                "risk_level": {"type": "string", "enum": ["high", "medium", "low"]},
                "event_type": {"type": "string"},
                "limit": {"type": "integer", "default": 100},
            },
            "required": [],
        },
    },
    {
        "name": "count_by_type",
        "description": "Get event counts grouped by event_type",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "count_by_risk",
        "description": "Get event counts grouped by risk_level",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_drift_report",
        "description": "Get drift monitoring precision report",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_feedback",
        "description": "Get recent operator feedback",
        "input_schema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "default": 100}},
            "required": [],
        },
    },
]


# ---------------------------------------------------------------------------
# Agent execution engine
# ---------------------------------------------------------------------------

@dataclass
class AgentResult:
    agent_type: str
    output: str
    steps: int
    tool_calls: list[str]
    latency_ms: float
    success: bool
    error: str | None = None

    def as_dict(self) -> dict:
        return {
            "agent_type": self.agent_type,
            "output": self.output,
            "steps": self.steps,
            "tool_calls": self.tool_calls,
            "latency_ms": round(self.latency_ms, 1),
            "success": self.success,
            "error": self.error,
        }


class AgentExecutor:
    """Runs a tool-calling agent loop using the Anthropic messages API.

    The loop:
      1. Send the system + user prompt (+ tool definitions) to the LLM.
      2. If the response contains tool_use blocks, execute each tool,
         collect results, and send them back as tool_result messages.
      3. Repeat until the model returns a text response (no more tool calls)
         or MAX_STEPS is reached.
    """

    def __init__(
        self,
        event_lookup: Callable[[str], dict | None],
        events_source: Callable[[], list[dict]],
        drift_monitor=None,
    ):
        self._event_lookup = event_lookup
        self._events_source = events_source
        self._drift_monitor = drift_monitor

    def _dispatch_tool(self, name: str, args: dict) -> str:
        """Execute a tool call and return the result as a JSON string."""
        if name == "get_event":
            result = tool_get_event(self._event_lookup, args.get("event_id", ""))
            return json.dumps(result or {"error": "event not found"}, default=str)
        if name == "get_recent_events":
            result = tool_get_recent_events(
                self._events_source,
                risk_level=args.get("risk_level"),
                event_type=args.get("event_type"),
                limit=args.get("limit", 50),
            )
            return json.dumps(result, default=str)
        if name == "get_policy":
            return tool_get_policy(args.get("filename"))
        if name == "get_feedback":
            result = tool_get_feedback(args.get("limit", 100))
            return json.dumps(result, default=str)
        if name == "get_drift_report":
            if self._drift_monitor:
                result = tool_get_drift_report(self._drift_monitor)
                return json.dumps(result, default=str)
            return '{"error": "drift monitor not available"}'
        if name == "count_by_type":
            return json.dumps(tool_count_by_type(self._events_source))
        if name == "count_by_risk":
            return json.dumps(tool_count_by_risk(self._events_source))
        return json.dumps({"error": f"unknown tool: {name}"})

    async def run(
        self,
        agent_type: str,
        system_prompt: str,
        user_prompt: str,
        tools: list[dict],
        model: str = "claude-haiku-4-5-20251001",
        max_tokens: int = 1024,
    ) -> AgentResult:
        from anthropic import AsyncAnthropic
        from road_safety.services.llm import _ANTHROPIC_KEY, llm_configured

        if not llm_configured() or not _ANTHROPIC_KEY:
            return AgentResult(
                agent_type=agent_type, output="LLM not configured",
                steps=0, tool_calls=[], latency_ms=0, success=False,
                error="no LLM backend",
            )

        client = AsyncAnthropic(api_key=_ANTHROPIC_KEY)
        messages: list[dict] = [{"role": "user", "content": user_prompt}]
        tool_call_log: list[str] = []
        t0 = time.monotonic()

        for step in range(MAX_STEPS):
            try:
                resp = await client.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    system=system_prompt,
                    messages=messages,
                    tools=tools,
                )
            except Exception as exc:
                elapsed = (time.monotonic() - t0) * 1000
                llm_observer.record(
                    call_type=f"agent_{agent_type}", model=model,
                    latency_ms=elapsed, success=False, error=str(exc),
                )
                return AgentResult(
                    agent_type=agent_type, output="",
                    steps=step, tool_calls=tool_call_log,
                    latency_ms=elapsed, success=False, error=str(exc),
                )

            tool_uses = [b for b in resp.content if b.type == "tool_use"]
            text_blocks = [b for b in resp.content if b.type == "text"]

            if not tool_uses:
                elapsed = (time.monotonic() - t0) * 1000
                output = "\n".join(b.text for b in text_blocks)
                usage = getattr(resp, "usage", None)
                llm_observer.record(
                    call_type=f"agent_{agent_type}", model=model,
                    input_tokens=getattr(usage, "input_tokens", 0) if usage else 0,
                    output_tokens=getattr(usage, "output_tokens", 0) if usage else 0,
                    latency_ms=elapsed, success=True,
                )
                return AgentResult(
                    agent_type=agent_type, output=output,
                    steps=step + 1, tool_calls=tool_call_log,
                    latency_ms=elapsed, success=True,
                )

            messages.append({"role": "assistant", "content": resp.content})

            tool_results = []
            for tu in tool_uses:
                tool_call_log.append(f"{tu.name}({json.dumps(tu.input)})")
                result_str = self._dispatch_tool(tu.name, tu.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": result_str[:4000],
                })
            messages.append({"role": "user", "content": tool_results})

        elapsed = (time.monotonic() - t0) * 1000
        llm_observer.record(
            call_type=f"agent_{agent_type}", model=model,
            latency_ms=elapsed, success=True,
        )
        output = "Agent reached maximum steps without final answer."
        return AgentResult(
            agent_type=agent_type, output=output,
            steps=MAX_STEPS, tool_calls=tool_call_log,
            latency_ms=elapsed, success=True,
        )


# ---------------------------------------------------------------------------
# Pre-built agent prompts
# ---------------------------------------------------------------------------

COACHING_SYSTEM = (
    "You are a safety coaching assistant. Given a safety event, generate "
    "a structured coaching note for the road safety manager. Use the available tools "
    "to retrieve the event details and relevant road safety policy.\n\n"
    "Your output MUST be a JSON object with these fields:\n"
    '  "event_id": string,\n'
    '  "severity": "high" | "medium" | "low",\n'
    '  "what_happened": string (2-3 sentences describing the incident),\n'
    '  "why_it_matters": string (safety impact, citing policy if relevant),\n'
    '  "recommended_action": string (specific coaching for the driver),\n'
    '  "policy_reference": string | null (filename and section if applicable)\n'
    "\nReturn ONLY the JSON object, no markdown fences or preamble."
)

INVESTIGATION_SYSTEM = (
    "You are a safety investigator. Given an event_id, conduct a "
    "structured investigation by gathering event details, checking for "
    "similar recent events, reviewing operator feedback, consulting road safety "
    "policy, and checking drift reports.\n\n"
    "Your output MUST be a JSON object with these fields:\n"
    '  "event_id": string,\n'
    '  "summary": string (what happened),\n'
    '  "similar_events": list of event_ids with similar characteristics,\n'
    '  "pattern_detected": boolean,\n'
    '  "pattern_description": string | null,\n'
    '  "operator_feedback_summary": string,\n'
    '  "drift_status": string (current precision and trend),\n'
    '  "root_cause_hypothesis": string,\n'
    '  "recommended_action": string,\n'
    '  "confidence": "high" | "medium" | "low"\n'
    "\nReturn ONLY the JSON object, no markdown fences or preamble."
)

REPORT_SYSTEM = (
    "You are a safety report generator. Produce a structured safety "
    "summary using the available tools to gather event counts, drift data, "
    "and operator feedback.\n\n"
    "Your output MUST be a JSON object with these fields:\n"
    '  "period": string (description of the reporting period),\n'
    '  "total_events": integer,\n'
    '  "by_risk": {"high": int, "medium": int, "low": int},\n'
    '  "by_type": dict of event_type -> count,\n'
    '  "top_issues": list of strings (top 3 safety concerns),\n'
    '  "precision_status": string (current model precision and trend),\n'
    '  "operator_engagement": string (feedback volume and sentiment),\n'
    '  "recommendations": list of strings (top 3 action items)\n'
    "\nReturn ONLY the JSON object, no markdown fences or preamble."
)


async def run_coaching_agent(
    executor: AgentExecutor, event_id: str
) -> AgentResult:
    return await executor.run(
        agent_type="coaching",
        system_prompt=COACHING_SYSTEM,
        user_prompt=f"Generate a coaching note for event: {event_id}",
        tools=COACHING_TOOLS,
    )


async def run_investigation_agent(
    executor: AgentExecutor, event_id: str
) -> AgentResult:
    return await executor.run(
        agent_type="investigation",
        system_prompt=INVESTIGATION_SYSTEM,
        user_prompt=f"Investigate event: {event_id}. Gather all relevant context before forming conclusions.",
        tools=INVESTIGATION_TOOLS,
    )


async def run_report_agent(executor: AgentExecutor) -> AgentResult:
    return await executor.run(
        agent_type="report",
        system_prompt=REPORT_SYSTEM,
        user_prompt="Generate a safety summary report for the current session. Query all available data sources.",
        tools=REPORT_TOOLS,
        max_tokens=2048,
    )
