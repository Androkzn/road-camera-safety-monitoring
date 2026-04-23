"""Watchdog incident-queue package.

Groups operational symptoms into fingerprinted incidents (severity,
category, impact, likely cause, owner, debug commands) — an incident
queue, not a log tail. Split into deterministic rule checks
([rules.py](rules.py)), an additive LLM hypothesis layer
([ai.py](ai.py)), the background loop + stats aggregator
([api.py](api.py)), the append-only JSONL writer / reader
([storage.py](storage.py)), and the finding dataclass + fingerprint
helpers ([model.py](model.py)). Monitoring never depends on LLM
availability — rules always fire, and on fingerprint / title
collision the rule finding wins.

Re-exports
----------
Makes the following names importable from this package:
- ``Watchdog`` — from [api.py](api.py)
- ``stats`` — from [api.py](api.py)
- ``WatchdogFinding`` — from [model.py](model.py)
- ``make_finding`` — from [model.py](model.py)
- ``normalize_finding`` — from [model.py](model.py)
- ``normalize_finding_payload`` — from [model.py](model.py)
- ``rule_checks`` — from [rules.py](rules.py)
- ``delete_findings`` — from [storage.py](storage.py)
- ``delete_findings_by_id`` — from [storage.py](storage.py)
- ``tail`` — from [storage.py](storage.py)
- ``write_finding`` — from [storage.py](storage.py)
- ``_rule_checks`` / ``_write_finding`` — legacy aliases for the
  pre-split flat-module surface.

UI connection
-------------
Page: MonitoringPage
UI element: the watchdog incident table and summary cards powered by
            ``/api/watchdog``, ``/api/watchdog/recent``, and
            ``/api/watchdog/findings*``.
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
