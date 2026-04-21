"""Watchdog persistence: append-only JSONL writer + reader.

Every finding is stored as one line in ``data/watchdog.jsonl`` (same
pattern as the audit log). This file + the in-process grouping step in
[model.group_findings](model.py) is the source of truth for the public
read APIs in [api.py](api.py).

Public surface (also re-exported from ``backend.services.watchdog``):

- :func:`write_finding`           — append one normalized finding.
- :func:`tail`                    — read the most recent N findings.
- :func:`delete_findings`         — delete by zero-based line index (or all).
- :func:`delete_findings_by_id`   — delete by ``{snapshot_id}_{ts}`` key.
"""

from __future__ import annotations

import json
import threading

from backend.config import DATA_DIR

from .model import WatchdogFinding, normalize_finding, normalize_finding_payload

# Append-only JSON-Lines file where every finding is persisted.
_WATCHDOG_PATH = DATA_DIR / "watchdog.jsonl"

# Default slice size used by ``tail()`` when reading recent findings.
_MAX_TAIL = 200

# Process-wide mutex guarding read-then-write of the jsonl file so
# concurrent writers don't interleave partial lines.
_lock = threading.Lock()


def write_finding(finding: WatchdogFinding) -> None:
    """Append a single normalized finding to ``data/watchdog.jsonl``.

    Disk errors are silenced — monitoring must never take down the main
    process because it cannot write its own output. The next tick will
    try again.
    """
    try:
        finding = normalize_finding(finding)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _lock:
            with _WATCHDOG_PATH.open("a", encoding="utf-8") as f:
                f.write(json.dumps(finding.as_dict(), ensure_ascii=False, default=str) + "\n")
    except OSError:
        # Disk full / permission denied / missing volume — narrow except
        # so we don't mask programming bugs unrelated to I/O.
        pass


def tail(n: int = _MAX_TAIL) -> list[dict]:
    """Return the most recent ``n`` watchdog findings as normalized dicts.

    Missing file, unreadable file, and malformed lines all yield an
    empty-or-partial list rather than raising, so callers can rely on
    this function under failure.
    """
    if not _WATCHDOG_PATH.exists():
        return []
    try:
        lines = _WATCHDOG_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for raw in lines[-n:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            out.append(normalize_finding_payload(json.loads(raw)))
        except json.JSONDecodeError:
            continue
    return out


def delete_findings(indices: list[int] | None = None) -> int:
    """Delete findings by zero-based line index, or all if indices is None."""
    if not _WATCHDOG_PATH.exists():
        return 0
    with _lock:
        try:
            lines = _WATCHDOG_PATH.read_text(encoding="utf-8").splitlines()
        except OSError:
            return 0
        if indices is None:
            count = len(lines)
            _WATCHDOG_PATH.write_text("", encoding="utf-8")
            return count
        to_remove = set(indices)
        kept = [line for i, line in enumerate(lines) if i not in to_remove]
        removed = len(lines) - len(kept)
        _WATCHDOG_PATH.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        return removed


def delete_findings_by_id(snapshot_ids: list[str]) -> int:
    """Delete findings matching any of the given ``snapshot_id_ts`` keys.

    The UI identifies a finding by the composite key ``{snapshot_id}_{ts}``
    rather than by line index (indices are unstable under concurrent
    writes).
    """
    if not _WATCHDOG_PATH.exists():
        return 0
    ids_set = set(snapshot_ids)
    with _lock:
        try:
            lines = _WATCHDOG_PATH.read_text(encoding="utf-8").splitlines()
        except OSError:
            return 0
        kept: list[str] = []
        removed = 0
        for line in lines:
            raw = line.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
                key = f"{obj.get('snapshot_id', '')}_{obj.get('ts', '')}"
                if key in ids_set:
                    removed += 1
                    continue
            except json.JSONDecodeError:
                # Corrupt row — keep it so a manual editor can recover it.
                pass
            kept.append(line)
        _WATCHDOG_PATH.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        return removed
