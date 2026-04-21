"""Data-retention control routes (manual sweep trigger).

A "retention sweep" enforces the privacy invariant: thumbnails + event
records older than the configured retention cutoff are deleted from
disk (``data/thumbs/`` and the events JSONL). The sweep runs
automatically every hour from ``backend.compliance.retention`` (see
the startup task wired in ``backend/server.py``); this router exposes
a POST to force one immediately — useful during testing or right
after a privacy-policy change where you need the old data gone now,
not at the top of the next hour.

UI connection
-------------
Page: None (operator-only endpoint, not surfaced in the React frontend).
UI element: No direct UI — an operator triggers the sweep manually after
changing a privacy policy, by hitting this endpoint directly. No
React hook in ``frontend/src/**`` references this route.
Backend route(s): POST /api/retention/sweep.
Backend services used: ``backend.compliance.retention.run_sweep``
(actual filesystem work) and ``backend.compliance.audit.log`` (records
who triggered the manual run).
"""

from fastapi import APIRouter

from backend.compliance import audit
from backend.compliance.retention import run_sweep as retention_sweep

# ``APIRouter`` — grouping container for the routes below.
router = APIRouter()


@router.post("/api/retention/sweep")
def api_retention_sweep():
    """Trigger an immediate retention sweep (normally runs hourly).

    HTTP: POST /api/retention/sweep
    Takes no body.
    Returns: dict summarising files deleted by the sweep (shape is
        whatever ``retention.run_sweep()`` returns — typically per-bucket
        counts of thumbnails / events removed).
    FE caller: none.
    Side effects:
        - Deletes files older than the configured retention cutoff from
          disk (thumbnails, events JSONL, etc.).
        - Writes an ``audit.log("retention_sweep", "manual_trigger")``
          entry BEFORE running the sweep so the trigger is recorded even
          if the sweep itself throws.
    """
    audit.log("retention_sweep", "manual_trigger")
    return retention_sweep()
