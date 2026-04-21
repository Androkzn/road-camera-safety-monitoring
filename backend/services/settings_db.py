"""Settings Console — SQLite persistence layer.

All durable state lives in ``data/settings.db`` (single-writer file model
under the edge process). The schema is intentionally tiny and is
bootstrapped by a one-shot migration runner at module import time.

Tables:
    * ``migrations``         — applied schema versions.
    * ``apply_log``          — every settings apply (success or failure).

The module exposes a small set of free functions plus a context-managed
:func:`connect` so callers do not have to think about cursor lifecycle.
SQLite is opened with ``check_same_thread=False`` because the FastAPI
worker thread and background tasks both write.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from backend.config import DATA_DIR


_DB_PATH: Path = DATA_DIR / "settings.db"


# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------
# A single shared connection (and a lock) is the simplest reliable pattern
# for SQLite under the edge process. Multiple connections to the same file
# are also fine, but they make WAL bookkeeping noisier; one connection +
# a lock keeps writes serialized and reads cheap.
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _open() -> sqlite3.Connection:
    """Open (and memoize) the singleton connection, ensuring the dir exists."""
    global _conn
    if _conn is not None:
        return _conn
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        _DB_PATH,
        check_same_thread=False,
        isolation_level=None,  # autocommit; we wrap in explicit transactions when needed
        timeout=5.0,
    )
    # Row factory so cursor results behave like dicts.
    conn.row_factory = sqlite3.Row
    # WAL gives much better read concurrency vs the default rollback journal.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _conn = conn
    _migrate(conn)
    return conn


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Context-managed access to the shared connection.

    Holds the module-level lock for the duration of the ``with`` block —
    fine for our write volumes (handfuls of apply rows per day).
    """
    with _lock:
        yield _open()


# ---------------------------------------------------------------------------
# Schema migrations
# ---------------------------------------------------------------------------
def _migrate(conn: sqlite3.Connection) -> None:
    """Apply any unapplied migrations.

    Migrations are tiny and inline; bumping the schema version means adding
    a new ``if`` arm here and a single CREATE / ALTER block.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS migrations (
            version INTEGER PRIMARY KEY,
            applied_at REAL NOT NULL
        )
        """
    )
    cur = conn.execute("SELECT MAX(version) AS v FROM migrations")
    current = cur.fetchone()["v"] or 0

    if current < 1:
        conn.executescript(
            """
            CREATE TABLE apply_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                actor_label TEXT NOT NULL,
                revision_hash_before TEXT NOT NULL,
                revision_hash_after TEXT NOT NULL,
                result TEXT NOT NULL,
                warnings_json TEXT NOT NULL DEFAULT '[]',
                audit_id TEXT,
                payload_json TEXT NOT NULL
            );

            CREATE INDEX idx_apply_log_ts ON apply_log(ts DESC);
            CREATE INDEX idx_apply_log_audit ON apply_log(audit_id);
            """
        )
        conn.execute(
            "INSERT INTO migrations(version, applied_at) VALUES (?, ?)",
            (1, time.time()),
        )


# ---------------------------------------------------------------------------
# Apply log
# ---------------------------------------------------------------------------
def insert_apply_log(
    *,
    actor_label: str,
    revision_hash_before: str,
    revision_hash_after: str,
    result: str,
    warnings: list[str],
    payload: dict[str, Any],
    audit_id: str | None = None,
) -> int:
    """Append one row to the apply log; returns the new row id."""
    now = time.time()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO apply_log(
                ts, actor_label, revision_hash_before, revision_hash_after,
                result, warnings_json, audit_id, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now,
                actor_label,
                revision_hash_before,
                revision_hash_after,
                result,
                json.dumps(warnings),
                audit_id,
                json.dumps(payload, sort_keys=True, default=str),
            ),
        )
        return cur.lastrowid


def list_apply_log(limit: int = 50) -> list[dict[str, Any]]:
    with connect() as conn:
        cur = conn.execute(
            "SELECT * FROM apply_log ORDER BY ts DESC LIMIT ?",
            (limit,),
        )
        rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        d["warnings"] = json.loads(d.pop("warnings_json") or "[]")
        d["payload"] = json.loads(d.pop("payload_json") or "{}")
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# Test helper — never call from production code
# ---------------------------------------------------------------------------
def _reset_for_tests(path: Path | None = None) -> None:
    """Re-point the singleton at a fresh DB. Used by the pytest fixtures.

    The tests pass a tmp_path-derived ``Path`` so each test gets isolation.
    Production code never calls this.
    """
    global _conn, _DB_PATH
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except sqlite3.Error:
                pass
        _conn = None
        if path is not None:
            _DB_PATH = path
