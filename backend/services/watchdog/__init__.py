"""AI-powered background watchdog — the operational incident queue.

Responsibility
--------------
This package is the single home for the fleet-safety system's
"incident queue". It is NOT a logger, it is NOT a log-tail of red
text, and it is deliberately NOT a stream of every error that ever
happened. Instead it groups repeated operational symptoms into
fingerprinted *incidents*, each of which carries enough context for an
on-call engineer to act:

- ``severity``          error | warning | info
- ``category``          perception | drift | llm | stream | scene | system
- ``impact``            what this means for fleet operations
- ``likely_cause``      the most probable root cause (observed or inferred)
- ``owner``             the team that normally debugs this class of issue
- ``evidence``          small structured facts (label/value/threshold/status)
- ``investigation_steps`` ordered human-readable troubleshooting steps
- ``debug_commands``    ready-to-paste shell / curl commands
- ``runbook``           one-liner linking the finding to standing guidance
- ``priority_score``    unified sort key across severity + evidence density
- ``fingerprint``       dedupe key so repeats do NOT create new rows
- ``source``            ``rule`` (deterministic) or ``ai`` (hypothesis)
- ``cause_confidence``  ``observed`` for rule-based, ``inferred`` for AI

Package layout
--------------
The package was split out of a single ~1,800-line module because it
had grown to own four distinct concerns. Each sub-module now owns
exactly one of them:

- [model.py](model.py)   — the :class:`WatchdogFinding` dataclass plus
                           every helper that shapes a finding (slug,
                           fingerprint, defaults table, normalization,
                           grouping, :func:`make_finding`).
- [rules.py](rules.py)   — deterministic rule-based detectors. Always
                           available; never depends on LLM.
- [ai.py](ai.py)         — Claude-powered hypothesis layer. Strictly
                           additive; silent no-op when LLM is absent.
- [storage.py](storage.py) — the append-only JSONL writer + reader
                             (``data/watchdog.jsonl``).
- [api.py](api.py)       — :class:`Watchdog` background loop and
                           :func:`stats` aggregator surfaced to
                           ``/api/watchdog``.

Design invariant
----------------
Monitoring must never depend on LLM availability. If the provider is
down, rule-based findings still fire, still dedupe, still persist, and
still render. The AI layer is strictly additive. On fingerprint OR
title collision, the rule finding wins.

Consumers
---------
The frontend ``MonitoringPage`` is the primary consumer. It reads
through these endpoints in ``backend/api/routers/watchdog.py``:

- ``/api/watchdog``              summary stats + top incidents
- ``/api/watchdog/recent``       most recent raw findings
- ``/api/watchdog/findings*``    list / delete endpoints used by the UI
"""

from __future__ import annotations

# ----- public surface -----
# Names exposed here are what existing callers import. Keep this list
# tight; add to it only when a new caller needs a new name, so the
# package interface stays small and obvious.

from .api import Watchdog, stats
from .model import (
    WatchdogFinding,
    make_finding,
    normalize_finding,
    normalize_finding_payload,
)
from .rules import rule_checks
from .storage import (
    delete_findings,
    delete_findings_by_id,
    tail,
    write_finding,
)

# ----- legacy aliases -----
# These underscore-prefixed aliases preserve the old flat-module public
# surface so that callers and tests written before the split keep
# working without edits. Prefer the new unprefixed names for new code.

_rule_checks = rule_checks
_write_finding = write_finding

__all__ = [
    "Watchdog",
    "WatchdogFinding",
    "delete_findings",
    "delete_findings_by_id",
    "make_finding",
    "normalize_finding",
    "normalize_finding_payload",
    "rule_checks",
    "stats",
    "tail",
    "write_finding",
    # Legacy aliases:
    "_rule_checks",
    "_write_finding",
]
