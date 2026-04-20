"""Server-Sent Events + copilot chat routes.

Three endpoints:

* ``/stream/events`` — public SSE of safety events.
* ``/chat`` — public copilot Q&A over recent events + statute corpus.
* ``/admin/detections`` — auth-gated SSE of per-frame detection snapshots.
"""

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from road_safety.compliance import audit
from road_safety.config import SSE_REPLAY_COUNT
from road_safety.security.signing import require_media_auth
from road_safety.services.llm import chat as llm_chat
from road_safety.state import state

router = APIRouter()


@router.get("/stream/events")
async def stream_events(request: Request):
    """Server-Sent Events feed of live safety events.

    HTTP: GET /stream/events
    AUTH: public
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
    # tell from gaps in event_id sequence that a reconnect is needed.
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    state.subscribers.add(queue)

    async def gen():
        try:
            # Replay recent buffer so a fresh client sees context, not
            # just the next new event.
            for ev in state.recent_events[-SSE_REPLAY_COUNT:]:
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


@router.post("/chat")
async def chat(body: dict):
    """Copilot endpoint — RAG-style Q&A over recent events + statute corpus.

    HTTP: POST /chat
    AUTH: public
    Request body: ``{"query": "<free-text question>"}``
    Response: ``{"answer": "<LLM-generated answer>"}``
    Side effects: audit-logs the first 200 chars of the query.
    """
    query = (body.get("query") or "").strip()
    if not query:
        raise HTTPException(400, "missing 'query'")
    # Truncate to 200 chars in the audit log — long queries may contain
    # PII from the user; we only need enough to identify the pattern.
    audit.log("chat_query", query[:200])
    answer = await llm_chat(query, state.recent_events)
    return {"answer": answer}


@router.get("/admin/detections")
async def admin_detections_sse(request: Request):
    """SSE stream of per-frame detection snapshots for the admin dashboard.

    HTTP: GET /admin/detections
    AUTH: signed URL (BE-D13) OR admin bearer when ROAD_REQUIRE_AUTH=1.
          Signature key is the constant ``"detections:all"`` because this
          SSE is not source-scoped. Falls through to public when the flag
          is off (pre-cutover).
    Response: ``text/event-stream`` of JSON snapshots — frame counters
        plus object bounding boxes. Much lighter than the MJPEG feed,
        suitable for charts / counters.
    """
    require_media_auth("detections:all", request, realm="media:detections")
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
