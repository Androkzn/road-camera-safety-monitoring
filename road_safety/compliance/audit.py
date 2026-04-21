"""audit.py — append-only access log for privacy/compliance reviewers.

What it does:
    Records one line every time someone (human operator or the system
    itself) touches sensitive data: an unredacted thumbnail that contains
    faces or plates, a feedback submission, an active-learning export,
    a chat query, a DSAR request, a retention sweep, or a drift alert.
    Each line is a self-contained JSON object with a timestamp, actor,
    action verb, resource id, and outcome (success / denied / error).

Purpose:
    Insurance and fleet customers need to demonstrate GDPR Article 30
    ("records of processing activities") and SOC 2 access-logging
    controls. Rather than integrate a full SIEM on the edge device, this
    module writes a tamper-evident append-only file that operators can
    export on demand and that the admin UI can tail live.

How it works:
    Storage is a plain text file at ``data/audit.jsonl`` — "JSONL" means
    one JSON object per line, so appending is atomic-ish and tails are
    cheap. The env var ``ROAD_AUDIT_LOG=0`` disables writes entirely
    (useful for tests). A ``threading.Lock`` wraps each write: Python's
    ``with _lock:`` block is like a "one-at-a-time door" — only one
    HTTP worker thread can be inside the write section at a time, which
    prevents two requests from interleaving half-written lines. The
    ``default=str`` argument on ``json.dumps`` handles the edge case
    where someone passes a timestamp or Path object in ``detail=...``;
    it tells Python "if you don't know how to serialise this, call
    ``str()`` on it".

    Three public functions:
      * ``log(action, resource, ...)`` — append one record.
      * ``tail(n)``                    — read the last N records.
      * ``stats()``                    — count-by-action summary for UI.

Connects to:
    - Backend: ``road_safety/server.py`` imports this module as
      ``audit`` and calls ``audit.log(...)`` from the DSAR / unredacted
      thumbnail / feedback / chat / export routes. The ``/api/audit``
      and ``/api/audit/stats`` endpoints (also in ``server.py``) wrap
      ``tail()`` and ``stats()`` for read access.
    - UI: none directly wired today — the admin HealthStrip does not yet
      render audit stats. The ``/api/audit`` endpoints exist for a future
      admin page and for out-of-band SIEM export.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from road_safety.config import DATA_DIR

_DATA_DIR = DATA_DIR
_AUDIT_PATH = _DATA_DIR / "audit.jsonl"
_MAX_TAIL = 200
_ENABLED = os.getenv("ROAD_AUDIT_LOG", "1").lower() not in ("0", "false", "no")

_lock = threading.Lock()


def _write(record: dict) -> None:
    if not _ENABLED:
        return
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _lock:
            with _AUDIT_PATH.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except OSError:
        pass


def log(
    action: str,
    resource: str,
    *,
    actor: str = "system",
    outcome: str = "success",
    detail: dict[str, Any] | None = None,
    ip: str | None = None,
) -> None:
    """Write one audit record.

    action:   verb — "access_unredacted_thumbnail", "submit_feedback",
              "export_active_learning", "chat_query", "dsar_request",
              "retention_sweep", "drift_alert"
    resource: the object identifier (event_id, thumbnail name, etc.)
    actor:    operator ID or "system"
    outcome:  "success", "denied", "error"
    """
    record = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "action": action,
        "resource": resource,
        "actor": actor,
        "outcome": outcome,
    }
    if ip:
        record["ip"] = ip
    if detail:
        record["detail"] = detail
    _write(record)


def tail(n: int = _MAX_TAIL) -> list[dict]:
    """Return the most recent N audit records."""
    if not _AUDIT_PATH.exists():
        return []
    try:
        lines = _AUDIT_PATH.read_text(encoding="utf-8").splitlines()
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


def stats() -> dict:
    """Summary counts by action type for the dashboard."""
    records = tail(1000)
    by_action: dict[str, int] = {}
    for r in records:
        a = r.get("action", "unknown")
        by_action[a] = by_action.get(a, 0) + 1
    denied = sum(1 for r in records if r.get("outcome") == "denied")
    return {
        "total_records": len(records),
        "by_action": by_action,
        "denied_count": denied,
        "audit_enabled": _ENABLED,
    }
