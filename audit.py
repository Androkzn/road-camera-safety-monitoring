"""Audit logging for compliance (GDPR Art. 30, SOC 2).

Records access to sensitive resources — unredacted thumbnails, feedback
submissions, active-learning exports, chat interactions — so the
organisation can demonstrate who accessed what personal data, when.

Storage: append-only JSONL at ``data/audit.jsonl``. Each line is a
self-contained record with actor, action, resource, timestamp, and
outcome. The file is intended for periodic export to a SIEM / log
aggregator in production; the ``/api/audit`` endpoint provides a
read-only tail for the dashboard.

Thread-safe: writes go through a threading lock because DSAR thumbnail
access can happen on any HTTP worker thread.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_DATA_DIR = Path(__file__).parent / "data"
_AUDIT_PATH = _DATA_DIR / "audit.jsonl"
_MAX_TAIL = 200
_ENABLED = os.getenv("FLEET_AUDIT_LOG", "1").lower() not in ("0", "false", "no")

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
