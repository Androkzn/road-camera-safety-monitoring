"""Watchdog orchestration — background loop, dedupe, and the stats() aggregator.

This module is the outward-facing layer of the watchdog package. It
owns three responsibilities and nothing else:

1. The long-lived :class:`Watchdog` background loop, which ``ticks''
   on a fixed cadence (default 60s). Each tick runs the rule-based
   detectors in [rules.py](rules.py), optionally calls the AI
   hypothesis layer in [ai.py](ai.py), **dedupes** AI findings
   against the rule findings using the in-memory fingerprint/title
   set, writes every surviving finding to the JSONL file via
   [storage.py](storage.py), and updates in-process bookkeeping.
2. The on/off switch and tick cadence — both are state that lives on
   the :class:`Watchdog` instance. Sibling modules do not know when
   the loop runs.
3. The :func:`stats` aggregator consumed by the ``/api/watchdog``
   endpoint — reads the last 500 findings from [storage.py](storage.py),
   groups them into incidents, and returns severity/category
   breakdowns plus the top-5 incidents for the drawer.

Invariants that must hold across changes:

- Rule-based findings are the source of truth. The AI layer is
  strictly additive and is deduplicated here (by fingerprint **and**
  exact title), never in [ai.py](ai.py).
- A tick never raises. Failures in the collector, the rule
  detectors, the LLM path, or disk I/O are swallowed so monitoring is
  self-healing — the next tick just retries.
- Every finding produced during one tick shares a single
  ``snapshot_id`` (injected by :func:`rules.rule_checks`) so an
  operator can see at a glance which findings co-fired.

Python primer
-------------
- ``class Watchdog:`` declares a class; ``self`` is the instance
  reference (equivalent to ``this`` in JS/Java). Attributes prefixed
  with an underscore (``_interval``) are a convention meaning
  "internal, do not read from outside".
- ``async def`` / ``await`` — coroutine syntax. :meth:`run_loop` is a
  long-running coroutine that the server schedules once at startup;
  ``await asyncio.sleep(...)`` yields control back to the event loop
  so other requests keep flowing while we wait.
- ``asyncio.CancelledError`` — a special exception raised into a
  coroutine when the caller calls ``task.cancel()``. Re-raising it is
  the contract for "I noticed the cancellation, go ahead and stop
  me".
- ``Callable[[], dict]`` — a type hint meaning "a zero-argument
  callable that returns a dict".

UI connection
-------------
Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
       and the Watchdog drawer ([file](frontend/src/features/watchdog/components/WatchdogDrawer.tsx)).
UI element: The watchdog badge in every page header (shows
       ``run_count`` / ``last_run_ago_sec`` / top severity colour)
       and the incident drawer behind it (renders ``top_incidents``
       plus the ``by_severity`` / ``by_category`` counters).
Backend route(s): ``GET /api/watchdog`` (consumes :meth:`Watchdog.status`),
       and indirectly ``GET /api/watchdog/recent`` — the same
       findings that this loop persists are what that endpoint
       returns. See [backend/api/routers/watchdog.py](../../api/routers/watchdog.py).
"""

from __future__ import annotations

import asyncio
import time
from typing import Callable

from .ai import ai_analyze
from .model import WatchdogFinding, group_findings, severity_rank
from .rules import rule_checks
from .storage import tail, write_finding


def stats() -> dict:
    """Aggregate the incident queue into the payload used by ``/api/watchdog``.

    A module-level function (not a method) because the HTTP layer in
    [backend/api/routers/watchdog.py](../../api/routers/watchdog.py)
    does not hold a reference to the :class:`Watchdog` instance when
    it just wants the queue stats.

    Reads the last 500 findings from [storage.py](storage.py), groups
    them into incidents with :func:`group_findings`, then returns
    severity / category counters plus the top-5 incidents sorted by:

    1. severity rank (error > warning > info),
    2. count (more repeats first), and
    3. most-recent timestamp as a tiebreaker.

    Returns:
        A dict with keys ``total_findings``, ``unique_incidents``,
        ``repeating_incidents``, ``by_severity``, ``by_category``, and
        ``top_incidents`` — exactly what the drawer UI consumes.
    """
    records = tail(500)
    by_severity: dict[str, int] = {}
    by_category: dict[str, int] = {}
    incidents = group_findings(records)
    for incident in incidents:
        sev = incident.get("severity", "unknown")
        by_severity[sev] = by_severity.get(sev, 0) + 1
        cat = incident.get("category", "unknown")
        by_category[cat] = by_category.get(cat, 0) + 1
    top_incidents = sorted(
        incidents,
        key=lambda i: (
            -severity_rank(str(i.get("severity", "info"))),
            -int(i.get("count", 0)),
            str(i.get("last_seen_ts", "")),
        ),
    )[:5]
    return {
        "total_findings": len(records),
        "unique_incidents": len(incidents),
        "repeating_incidents": sum(1 for i in incidents if int(i.get("count", 0)) > 1),
        "by_severity": by_severity,
        "by_category": by_category,
        "top_incidents": top_incidents,
    }


class Watchdog:
    """Background service that drives the incident queue.

    The server instantiates exactly one :class:`Watchdog` at startup,
    hands it a ``collect_fn()`` that knows how to assemble a fresh
    health snapshot, and schedules :meth:`run_loop` as a long-lived
    asyncio task. The loop then ticks every ``interval_sec`` seconds
    for the lifetime of the process; each tick runs the rule-based
    detectors, the AI hypothesis layer, the persistence step, and the
    bookkeeping update — in that order.

    Instance state (lives as long as the process):

    - ``_collect``            zero-argument callable supplied by the
                              caller that returns a snapshot dict.
    - ``_interval``           seconds between ticks. Also injected
                              into each snapshot as ``_interval_sec``
                              so rate-based detectors in
                              [rules.py](rules.py) stay pure.
    - ``_prev_snapshot``      the previous tick's snapshot, used by
                              the AI layer to compute deltas.
    - ``_last_run``           wall-clock time (epoch seconds) of the
                              last successful tick.
    - ``_run_count``          total ticks completed since startup.
    - ``_total_findings``     cumulative findings emitted since
                              startup (rule + AI combined).
    """

    def __init__(
        self,
        collect_fn: Callable[[], dict],
        interval_sec: int = 60,
    ):
        """Store the health collector and tick cadence; no work runs yet.

        ``__init__`` is Python's constructor — the method that runs
        when you write ``Watchdog(collect_fn=...)``. Nothing here
        starts the background loop; :meth:`run_loop` does that once
        the server's asyncio event loop exists.

        Args:
            collect_fn: A zero-argument callable returning a
                dict-shaped snapshot with ``perception``, ``drift``,
                ``llm``, ``pipeline``, ``server``, and ``taxonomy``
                sections. The watchdog does not care where the data
                comes from, only that calling ``collect_fn()`` returns
                a dict in that shape.
            interval_sec: Seconds between ticks. Defaults to 60. Also
                injected into each snapshot as ``_interval_sec`` so
                rate-based detectors can compute per-tick deltas
                without needing a reference to this object.
        """
        self._collect = collect_fn
        self._interval = interval_sec
        self._prev_snapshot: dict | None = None
        self._last_run: float = 0
        self._run_count: int = 0
        self._total_findings: int = 0

    def status(self) -> dict:
        """Return the live status payload rendered at ``/api/watchdog``.

        Merges the loop's own bookkeeping (``last_run``, ``run_count``,
        ``total_findings_emitted``, plus a derived
        ``last_run_ago_sec``) with the aggregated queue stats from
        :func:`stats`. The ``**stats()`` spread in the return value is
        Python's dict-unpacking syntax — it splats every key/value from
        ``stats()`` into the same dict literal.

        Called synchronously from the HTTP handler, so it must stay
        cheap; the expensive part (scanning the last 500 lines of the
        JSONL file) happens inside :func:`stats` and nowhere else.
        """
        return {
            "enabled": True,
            "interval_sec": self._interval,
            "last_run": self._last_run,
            "last_run_ago_sec": round(time.time() - self._last_run, 1) if self._last_run else None,
            "run_count": self._run_count,
            "total_findings_emitted": self._total_findings,
            **stats(),
        }

    async def check_once(self) -> list[WatchdogFinding]:
        """Execute one full tick: collect, analyse, deduplicate, persist.

        The ordering here is load-bearing — do not reorder without
        updating the invariants in the module docstring:

        1. Capture a fresh snapshot by calling ``self._collect()``.
        2. Run the rule-based detectors from [rules.py](rules.py)
           (always; synchronous; cannot fail the tick).
        3. Run the AI hypothesis layer from [ai.py](ai.py)
           (best-effort; returns ``[]`` if the LLM stack is down).
        4. Deduplicate AI findings against rule findings using both
           the structural ``fingerprint`` *and* the exact ``title`` —
           rule findings always win so the operator never sees a rule
           version and an AI version of the same incident side by side.
        5. Persist every surviving finding to the JSONL file via
           [storage.write_finding](storage.py).
        6. Advance bookkeeping (``_prev_snapshot``, ``_last_run``,
           ``_run_count``, ``_total_findings``) and return the list of
           findings that were actually emitted this tick.

        Returns:
            The full list of findings (rule + deduped AI) that were
            persisted during this tick. Exposed mainly so tests can
            assert against a single invocation without reading the
            JSONL file back.
        """
        snapshot = self._collect()
        # Inject the tick interval so rate-detectors stay pure and
        # don't need a reference to this object.
        snapshot["_interval_sec"] = self._interval

        findings = rule_checks(snapshot, self._prev_snapshot)

        ai_findings = await ai_analyze(snapshot, self._prev_snapshot)
        # Fingerprint OR title match is treated as "same thing" so the
        # queue does not show a rule and an AI version side-by-side.
        rule_fingerprints = {f.fingerprint for f in findings}
        rule_titles = {f.title for f in findings}
        for af in ai_findings:
            if af.fingerprint not in rule_fingerprints and af.title not in rule_titles:
                findings.append(af)

        for f in findings:
            write_finding(f)

        self._prev_snapshot = snapshot
        self._last_run = time.time()
        self._run_count += 1
        self._total_findings += len(findings)

        return findings

    async def run_loop(self) -> None:
        """Long-running background loop. Never returns under normal use.

        Scheduled once at server startup as an asyncio task. Each
        iteration calls :meth:`check_once` and then sleeps for
        ``self._interval`` seconds. Because this is a coroutine,
        ``await asyncio.sleep(...)`` hands control back to the event
        loop so the sleep does not block anything else.

        The 15-second startup sleep gives the rest of the stack time
        to finish booting before the first snapshot is taken —
        otherwise the first tick would fire on half-initialised state
        and produce spurious "stream stalled" findings.

        :class:`asyncio.CancelledError` is re-raised so the host's
        ``task.cancel()`` actually stops the loop at shutdown. Every
        *other* exception is swallowed intentionally: monitoring must
        be self-healing, so one bad tick (disk full, detector bug,
        LLM-side crash) must not kill watching forever. The next tick
        retries.
        """
        await asyncio.sleep(15)
        while True:
            try:
                await self.check_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Monitoring must be self-healing — next tick retries.
                pass
            await asyncio.sleep(self._interval)
