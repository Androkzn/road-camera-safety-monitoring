"""Watchdog service orchestration + summary stats surfaced to callers.

This module owns the long-lived :class:`Watchdog` background loop and
the :func:`stats` aggregator consumed by the monitoring UI. It is the
outward-facing layer that stitches :mod:`rules`, :mod:`ai`, and
:mod:`storage` together — everything reachable from ``/api/watchdog``
comes through here.

Orchestration guarantees (invariant):

- Rule-based findings are the source of truth. The AI layer is always
  additive — deduped against rule findings by fingerprint AND title so
  the queue never shows a rule + AI version of the same incident.
- A tick never raises: failures in the collector, detectors, or LLM
  path are swallowed so monitoring is self-healing.
- Every finding produced by one tick shares a single ``snapshot_id``
  (injected by :func:`rules.rule_checks`), so operators can reason
  about what co-fired in that moment.
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

    Reads the last 500 findings, groups them into incidents, and returns
    severity/category breakdowns plus the top-5 incidents sorted by
    severity, then count, then recency.
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

    The server instantiates one instance with a ``collect_fn()`` that
    knows how to assemble a health snapshot, then schedules
    :meth:`run_loop` on the asyncio event loop. The loop ticks every
    ``interval_sec`` seconds; each tick runs rule-based detectors + the
    AI layer + persistence + bookkeeping.

    State (lifecycle = lifetime of the process):

    - ``_collect``            caller-supplied zero-arg snapshot factory.
    - ``_interval``           seconds between ticks; also injected into
                              the snapshot as ``_interval_sec``.
    - ``_prev_snapshot``      the previous tick's snapshot (delta source).
    - ``_last_run``           wall-clock time of the last tick.
    - ``_run_count``          total ticks completed.
    - ``_total_findings``     cumulative findings emitted.
    """

    def __init__(
        self,
        collect_fn: Callable[[], dict],
        interval_sec: int = 60,
    ):
        """Store the health collector and the tick cadence.

        Args:
            collect_fn: A zero-arg callable returning a dict-shaped
                snapshot with ``perception``, ``drift``, ``llm``,
                ``pipeline``, ``server``, ``taxonomy`` sections.
            interval_sec: Seconds between ticks. Defaults to 60s.
        """
        self._collect = collect_fn
        self._interval = interval_sec
        self._prev_snapshot: dict | None = None
        self._last_run: float = 0
        self._run_count: int = 0
        self._total_findings: int = 0

    def status(self) -> dict:
        """Return the live status payload rendered at ``/api/watchdog``.

        Merges the loop's own bookkeeping (last run, run count, total
        emitted) with the aggregated queue stats from :func:`stats`.
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
        """Execute one full tick: collect, analyze, deduplicate, persist.

        Order is deliberately:

        1. Capture a fresh snapshot.
        2. Run rule-based detectors (always).
        3. Run the AI hypothesis layer (best-effort).
        4. Deduplicate AI findings against rule findings by fingerprint
           AND by exact title — rule findings always win.
        5. Persist every resulting finding to the jsonl file.
        6. Update bookkeeping and return the list.
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

        The 15-second startup sleep gives the rest of the stack time to
        finish booting before the first snapshot is taken — otherwise
        the first tick would fire on half-initialized state and produce
        spurious "stream stalled" findings.

        Cancellation is re-raised so ``task.cancel()`` from the host
        works; every other exception is swallowed so one bad tick does
        not kill monitoring forever.
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
