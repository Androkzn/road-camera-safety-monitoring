"""Operator feedback API — thumbs-up / thumbs-down verdicts per event.

Mounted from server.py via ``feedback_routes.mount(app)``. Writes are
append-only JSON-lines to ``data/feedback.jsonl`` — downstream drift-monitoring
jobs can tail that file.

Endpoints:
  POST /api/feedback          — record a verdict
  GET  /api/feedback          — last 100 lines parsed
  GET  /api/coaching_queue    — pending medium-risk events for operator review
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from road_safety.config import DATA_DIR
from road_safety.integrations import slack as slack_notify

FeedbackHook = Callable[[dict, Optional[dict]], Awaitable[None]]

_DATA_DIR = DATA_DIR
_FEEDBACK_PATH = _DATA_DIR / "feedback.jsonl"
_EVENTS_PATH = _DATA_DIR / "events.json"

_VALID_VERDICTS = {"tp", "fp"}


class FeedbackBody(BaseModel):
    event_id: str = Field(..., min_length=1, max_length=128)
    verdict: Literal["tp", "fp"]
    note: str | None = Field(default=None, max_length=2000)


async def _safe_hook(hook: FeedbackHook, record: dict, matched: dict | None) -> None:
    try:
        await hook(record, matched)
    except Exception as exc:
        print(f"[feedback] hook failed: {exc}")


def _append_feedback(record: dict) -> None:
    """Synchronous append — feedback writes are rare, blocking is fine."""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _FEEDBACK_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _read_tail(path: Path, n: int) -> list[dict]:
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    out: list[dict] = []
    for raw in lines[-n:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return out


def _medium_events_from_disk(limit: int) -> list[dict]:
    """Fallback when the in-memory buffer is empty: replay events.json."""
    if not _EVENTS_PATH.exists():
        return []
    try:
        with _EVENTS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, dict):
        data = data.get("events") or []
    if not isinstance(data, list):
        return []
    mediums = [e for e in data if isinstance(e, dict) and e.get("risk_level") == "medium"]
    return mediums[-limit:]


def mount(
    app: FastAPI,
    on_feedback: FeedbackHook | None = None,
    event_lookup: Callable[[str], dict | None] | None = None,
) -> None:
    """Register feedback + coaching-queue routes on the given FastAPI app.

    on_feedback: optional async callback fired after each verdict write, for
        drift recompute / active-learning sampling. Never blocks the HTTP
        response — fired via asyncio.create_task.
    event_lookup: optional sync resolver from event_id to the full event dict
        (e.g. a closure over state.recent_events). Used when building hook arg.
    """
    import asyncio

    @app.post("/api/feedback")
    async def post_feedback(body: FeedbackBody):
        if body.verdict not in _VALID_VERDICTS:
            # pydantic Literal normally catches this; belt-and-braces.
            raise HTTPException(status_code=400, detail="verdict must be 'tp' or 'fp'")
        record = {
            "event_id": body.event_id,
            "verdict": body.verdict,
            "note": body.note,
            "operator_ts": datetime.now(timezone.utc).isoformat(),
        }
        try:
            _append_feedback(record)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"write failed: {exc}") from exc
        if on_feedback is not None:
            matched = event_lookup(body.event_id) if event_lookup else None
            asyncio.create_task(_safe_hook(on_feedback, record, matched))
        return {"ok": True}

    @app.get("/api/feedback")
    async def get_feedback():
        return {"items": _read_tail(_FEEDBACK_PATH, 100)}

    @app.get("/api/coaching_queue")
    async def coaching_queue(limit: int = 50):
        if limit <= 0:
            raise HTTPException(status_code=400, detail="limit must be positive")
        limit = min(limit, 500)
        # Prefer the live in-memory buffer (what Slack would have sent);
        # fall back to disk for cold starts / restarts.
        buf = slack_notify.get_medium_buffer()
        if buf:
            items = buf[-limit:]
        else:
            items = _medium_events_from_disk(limit)
        return {"items": items, "count": len(items)}
