"""Append-only JSONL persistence for watchdog findings.

Every finding produced by the watchdog loop in [api.py](api.py) is
serialised here via its ``to_dict()`` shape and written as a single
line to ``data/watchdog.jsonl`` (one JSON object per line — the
"JSON-Lines" format, same pattern as the audit log). Reads return the
most-recent-first slice the UI wants without having to parse the
whole file every time.

This module is **deliberately simple**: there is no log rotation, no
compaction, and no indexing. That is a known gap — on a long-running
deployment the file grows without bound and the UI read-back (``tail``
loads the whole file and slices) gets slower over time. The gap is
documented here so future work has a clear starting point; sibling
modules must keep assuming an append-only flat file until that
changes.

What lives here vs elsewhere in the watchdog package:

- **Here**:   file I/O, the process-wide write lock, JSON-Lines
              formatting, and the tail/delete helpers the HTTP layer
              calls.
- **[model.py](model.py)**: the :class:`WatchdogFinding` dataclass,
              ``to_dict()`` serialisation, incident grouping, and
              fingerprint computation.
- **[api.py](api.py)**: the background loop that decides *when* to
              write, and the ``stats()`` aggregator that consumes
              :func:`tail`.

Public surface (also re-exported from ``backend.services.watchdog``):

- :func:`write_finding`           — append one normalised finding.
- :func:`tail`                    — read the most recent ``n`` findings.
- :func:`delete_findings`         — delete by zero-based line index
                                    (or clear all).
- :func:`delete_findings_by_id`   — delete by ``{snapshot_id}_{ts}`` key.

Python primer
-------------
- ``threading.Lock`` — a mutual-exclusion primitive. The ``with
  _lock:`` block acquires it on entry and releases it on exit (even
  if an exception is raised), exactly like a ``finally`` block. We
  use it to make sure two threads writing at the same time don't
  interleave partial lines in the file.
- ``with path.open("a", encoding="utf-8") as f:`` — opens the file in
  *append* mode; the ``with`` block guarantees ``f.close()`` runs on
  exit. ``"a"`` means "seek to end, create if missing".
- ``DATA_DIR / "watchdog.jsonl"`` — path joining using :class:`pathlib.Path`.
  The ``/`` operator is overloaded here; this is the Pythonic
  equivalent of ``os.path.join(DATA_DIR, "watchdog.jsonl")``.
- ``except OSError:`` — a **narrow** exception clause that only
  catches disk-side failures (permission denied, disk full, missing
  volume). Programming bugs still raise loudly.

UI connection
-------------
Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
       and the Watchdog drawer ([file](frontend/src/features/watchdog/components/WatchdogDrawer.tsx)).
UI element: The list of incident cards and the per-card "Delete"
       button in the Watchdog drawer; also the severity/category
       counters on the badge. All of those read rows written by
       :func:`write_finding` and delete them via
       :func:`delete_findings_by_id`.
Backend route(s): Indirectly feeds ``GET /api/watchdog`` (via
       :func:`stats` in [api.py](api.py)), ``GET /api/watchdog/recent``
       (direct :func:`tail` call), ``DELETE /api/watchdog/findings``
       (wipe via :func:`delete_findings`), and
       ``POST /api/watchdog/findings/delete`` (selective via
       :func:`delete_findings_by_id`). See
       [backend/api/routers/watchdog.py](../../api/routers/watchdog.py).
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
    """Append a single normalised finding to ``data/watchdog.jsonl``.

    Invoked once per finding by the loop in [api.py](api.py). The
    write is guarded by the process-wide :data:`_lock` so two
    concurrent writers cannot interleave half-lines.

    ``normalize_finding`` defensively fills in any missing optional
    fields on the dataclass before serialisation, so readers of the
    file can rely on a stable schema.

    Disk errors (:class:`OSError` — permission denied, disk full,
    missing volume) are silenced on purpose: monitoring must never
    take down the main process because it cannot write its own
    output. The next tick tries again. Non-I/O exceptions are *not*
    caught — a bug in ``to_dict()`` should still bubble up loudly.
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
    """Return the most recent ``n`` watchdog findings as normalised dicts.

    Loads the whole JSONL file into memory, splits on newlines, and
    slices the last ``n`` lines. This is deliberately simple — see
    the "known gap" note in the module docstring about rotation.

    Lines that fail to parse (truncated writes, manual edits gone
    wrong) are skipped silently; a missing file returns ``[]``. The
    goal is that callers can rely on this function **under failure**:
    UI endpoints will degrade to "empty" instead of 500-ing.

    Args:
        n: Maximum number of records to return. Defaults to
            :data:`_MAX_TAIL` (200).

    Returns:
        A list of per-line finding dicts, most recent *last* — i.e.
        preserving file order. Callers that want newest-first order
        reverse it themselves.
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
    """Delete findings by zero-based line index, or clear all when ``indices`` is ``None``.

    Two modes:

    - ``indices is None`` — truncate the whole file to empty. Returns
      the number of lines that had been in the file.
    - ``indices`` provided — rewrite the file keeping only lines
      whose index is **not** in the given list. Returns the number
      of lines actually removed.

    The whole operation is guarded by :data:`_lock` so it cannot race
    with a concurrent :func:`write_finding`.

    Line indices are not stable under concurrent writes — if two
    operators delete different findings at the same time, one
    operator's indices can shift underneath the other. That is why
    the HTTP layer prefers :func:`delete_findings_by_id` for
    selective deletes and reserves this function for the "clear all"
    button.

    Args:
        indices: Zero-based line numbers to delete, or ``None`` to
            clear the file.

    Returns:
        The count of lines removed.
    """
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
    """Delete findings matching any of the given ``{snapshot_id}_{ts}`` keys.

    This is the preferred selective-delete path for the UI. Every
    finding has a composite key ``"{snapshot_id}_{ts}"`` (snapshot id
    plus ISO timestamp) that is stable across writes — unlike line
    indices, which shift whenever another finding is appended or
    another delete runs. The drawer uses this key on its per-card
    "Delete" button.

    Reads the whole file, filters out rows whose composite key is in
    the input set, and rewrites the remaining rows back in one
    locked pass.

    Corrupt rows (failed ``json.loads``) are **kept** rather than
    silently dropped — keeping them on disk means a human can
    recover the data manually. Silent drops would hide bugs.

    Args:
        snapshot_ids: A list of ``"{snapshot_id}_{ts}"`` composite
            keys to remove. Duplicates are fine; a key that does not
            match any row is a no-op.

    Returns:
        The number of findings actually removed.
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
