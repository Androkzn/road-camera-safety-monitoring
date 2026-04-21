"""Server-Sent Events + copilot chat routes.

Three endpoints:

* ``/stream/events`` — SSE of safety events (``SafetyEvent`` payloads).
* ``/chat`` — copilot Q&A over recent events + statute corpus.
* ``/admin/detections`` — SSE of per-frame detection snapshots.

Each SSE payload on ``/stream/events`` is a JSON-serialised
``SafetyEvent`` as declared in ``backend/api/models.py`` (mirrored to
TypeScript via ``scripts/generate_ts_types.py``). The contract is the
single source of truth — do not hand-edit the TS shim.

UI connection
-------------
Page: DashboardPage + AdminPage + MonitoringPage + ValidationPage.
FE hooks that consume this router:
* ``EventStreamProvider`` (frontend/src/shared/events/EventStreamProvider.tsx)
  and ``useEventStream`` (frontend/src/shared/hooks/useEventStream.ts)
  — a single provider opens one ``/stream/events`` connection and fans
  out to every page's live-event list.
* ``useSSE`` (frontend/src/shared/hooks/useSSE.ts) — the underlying
  reconnecting EventSource helper.
* The admin detection overlay subscribes to ``/admin/detections``
  directly from the admin page.
UI element: the live event cards (every page subscribes to /stream/events
through the shared provider); the dashboard's copilot chat input box
(/chat); and the admin page's per-frame bounding-box overlays
(/admin/detections SSE feeds the detection panel).

Backend services used
---------------------
* ``backend.state.state`` — ``state.subscribers`` (safety-event fanout
  queues) and ``state.admin_detection_subscribers`` (detection fanout).
* ``backend.services.llm.chat`` — copilot Q&A; inherits failover /
  circuit breaker / rate budget from the shared LLM wrapper.
* ``backend.compliance.audit`` — chat queries are audit-logged (first
  200 chars only, to avoid persisting user PII).
* ``backend.config.SSE_REPLAY_COUNT`` — replay depth on reconnect.
"""

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.api.models import ChatResponse
from backend.compliance import audit
from backend.config import SSE_REPLAY_COUNT
from backend.services.llm import chat as llm_chat
from backend.state import state

router = APIRouter()


class ChatBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=4000)


@router.get("/stream/events")
async def stream_events(request: Request):
    """Server-Sent Events feed of live safety events.

    HTTP: GET /stream/events
    Response shape: ``text/event-stream``. Each message is a JSON-
        serialised event dict on a ``data:`` line; keepalives are sent as
        ``: keepalive`` comment frames so proxies don't drop the
        connection during quiet periods.
    Lifecycle:
        * Client connects: we create a per-client ``asyncio.Queue``, add
          it to ``state.subscribers``, and immediately replay the last
          ``SSE_REPLAY_COUNT`` events from the rolling buffer.
        * While connected: ``await queue.get()`` blocks for new events.
          A 15-second timeout sends a keepalive comment to keep the
          connection open even when the pipeline is quiet.
        * On disconnect: ``finally`` removes the queue from subscribers
          so ``_emit_event`` stops fanning to it.
    """
    # ``maxsize=200`` caps a single slow consumer at 200 buffered events
    # before broadcasts start dropping to their queue. The client can
    # tell from gaps in event_id sequence that a reconnect is needed —
    # every SafetyEvent carries a stable ``event_id`` (see
    # ``backend/api/models.py``) so ``useSSE`` can deduplicate replay
    # against its in-memory cache on reconnection.
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    state.subscribers.add(queue)

    async def gen():
        try:
            # Replay recent buffer so a fresh client sees context, not
            # just the next new event. ``SSE_REPLAY_COUNT`` bounds the
            # number of historical events; the client uses ``event_id``
            # to drop any it has already rendered.
            for ev in state.recent_events_snapshot(limit=SSE_REPLAY_COUNT):
                yield f"data: {json.dumps(ev)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            state.subscribers.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/chat", response_model=ChatResponse)
async def chat(body: ChatBody):
    """Copilot endpoint — RAG-style Q&A over recent events + statute corpus.

    HTTP: POST /chat
    Request body: ``{"query": "<free-text question>"}``
    Response: ``{"answer": "<LLM-generated answer>"}``
    Side effects: audit-logs the first 200 chars of the query.
    """
    query = body.query.strip()
    if not query:
        raise HTTPException(400, "missing 'query'")
    # Truncate to 200 chars in the audit log — long queries may contain
    # PII from the user; we only need enough to identify the pattern.
    audit.log("chat_query", query[:200])
    answer = await llm_chat(query, state.recent_events_snapshot())
    return {"answer": answer}


@router.get("/admin/detections")
async def admin_detections_sse(request: Request):
    """SSE stream of per-frame detection snapshots for the admin dashboard.

    HTTP: GET /admin/detections
    Response: ``text/event-stream`` of JSON snapshots — frame counters
        plus object bounding boxes. Much lighter than the JPEG feed,
        suitable for charts / counters.
    """
    # Smaller queue cap than the safety-event SSE — these messages are
    # per-frame at 2Hz; a client that's 50 frames behind already lost
    # 25 seconds of data and should reconnect anyway.
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    state.admin_detection_subscribers.add(queue)

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=10.0)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            state.admin_detection_subscribers.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
