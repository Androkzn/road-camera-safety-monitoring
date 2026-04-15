"""Fleet safety cloud receiver.

This is **deliberately a separate FastAPI app** from ``server.py``. In a real
deployment the edge node and the cloud receiver run on different hosts with
different trust boundaries, scaling profiles, and secrets. Keeping them in one
process would obscure the edge/cloud split the design is meant to demonstrate.

Run it standalone:

    uvicorn cloud_receiver:app --port 8001

It verifies HMAC-signed webhooks from ``edge_publisher.EdgePublisher``, dedupes
by ``event_id``, and persists to a local SQLite file at ``data/cloud.db``.

The receiver fails loudly at startup if ``FLEET_CLOUD_HMAC_SECRET`` is missing:
an unsigned-accepting ingest endpoint is worse than a disabled one.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request

logger = logging.getLogger("cloud_receiver")

ROOT = Path(__file__).parent
DB_PATH = Path(os.getenv("FLEET_CLOUD_DB", ROOT / "data" / "cloud.db"))
TIMESTAMP_WINDOW_SEC = 300  # +/- 5 minutes

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    event_id     TEXT PRIMARY KEY,
    received_at  INTEGER NOT NULL,
    source       TEXT NOT NULL,
    payload      TEXT NOT NULL,
    verdict      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source       ON events(source);
"""


def _require_secret() -> str:
    secret = os.getenv("FLEET_CLOUD_HMAC_SECRET")
    if not secret:
        raise RuntimeError(
            "FLEET_CLOUD_HMAC_SECRET is required. Refusing to start an ingest "
            "endpoint without a signing key."
        )
    return secret


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with _connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


# -------------------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Fail loud on misconfig.
    app.state.shared_secret = _require_secret()
    _init_db()
    logger.info("cloud_receiver ready; db=%s", DB_PATH)
    yield


app = FastAPI(title="Fleet Safety Cloud Receiver", lifespan=_lifespan)


# -------------------------------------------------------------------------------------


def _verify_signature(secret: str, ts_header: str | None, sig_header: str | None, body: bytes) -> None:
    if not ts_header or not sig_header:
        raise HTTPException(status_code=401, detail="missing signature headers")
    try:
        ts = int(ts_header)
    except ValueError:
        raise HTTPException(status_code=401, detail="bad timestamp") from None
    now = int(time.time())
    if abs(now - ts) > TIMESTAMP_WINDOW_SEC:
        raise HTTPException(status_code=401, detail="timestamp outside window")

    msg = f"{ts}.".encode() + body
    expected = "sha256=" + hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig_header):
        raise HTTPException(status_code=401, detail="bad signature")


# -------------------------------------------------------------------------------------


@app.post("/ingest/events")
async def ingest_events(request: Request) -> dict[str, int]:
    body = await request.body()
    secret = request.app.state.shared_secret
    _verify_signature(
        secret,
        request.headers.get("X-Fleet-Timestamp"),
        request.headers.get("Signature"),
        body,
    )
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="invalid json") from None

    events = payload.get("events")
    source = payload.get("source") or request.headers.get("X-Fleet-Source") or "unknown"
    if not isinstance(events, list):
        raise HTTPException(status_code=400, detail="events must be list")

    accepted = 0
    duplicates = 0
    rejected = 0
    now = int(time.time())

    with _connect() as conn:
        for ev in events:
            if not isinstance(ev, dict):
                rejected += 1
                continue
            event_id = ev.get("event_id")
            if not event_id or not isinstance(event_id, str):
                rejected += 1
                continue
            cur = conn.execute(
                "INSERT OR IGNORE INTO events(event_id, received_at, source, payload) "
                "VALUES (?, ?, ?, ?)",
                (event_id, now, source, json.dumps(ev, separators=(",", ":"), default=str)),
            )
            if cur.rowcount == 1:
                accepted += 1
            else:
                duplicates += 1
        conn.commit()

    return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}


# -------------------------------------------------------------------------------------


@app.get("/events")
async def list_events(limit: int = 100, risk_level: str | None = None) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    q = "SELECT event_id, received_at, source, payload FROM events"
    params: list[Any] = []
    if risk_level:
        q += " WHERE json_extract(payload, '$.risk_level') = ?"
        params.append(risk_level)
    q += " ORDER BY received_at DESC LIMIT ?"
    params.append(limit)

    with _connect() as conn:
        rows = conn.execute(q, params).fetchall()

    events = []
    for r in rows:
        try:
            ev = json.loads(r["payload"])
        except json.JSONDecodeError:
            ev = {"_parse_error": True}
        ev["_received_at"] = r["received_at"]
        ev["_source"] = r["source"]
        events.append(ev)
    return {"events": events, "count": len(events)}


# -------------------------------------------------------------------------------------


@app.get("/stats")
async def stats() -> dict[str, Any]:
    with _connect() as conn:
        total = conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"]
        last = conn.execute(
            "SELECT MAX(received_at) AS ts FROM events"
        ).fetchone()["ts"]
        per_risk_rows = conn.execute(
            "SELECT json_extract(payload, '$.risk_level') AS rl, COUNT(*) AS c "
            "FROM events GROUP BY rl"
        ).fetchall()
        per_type_rows = conn.execute(
            "SELECT json_extract(payload, '$.event_type') AS et, COUNT(*) AS c "
            "FROM events GROUP BY et"
        ).fetchall()

    return {
        "total": total,
        "last_received_at": last,
        "per_risk_level": {(r["rl"] or "unknown"): r["c"] for r in per_risk_rows},
        "per_event_type": {(r["et"] or "unknown"): r["c"] for r in per_type_rows},
    }


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
