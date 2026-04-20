"""Privacy primitives for the road-safety pipeline.

This module holds the small, invariant-bearing functions that scrub PII
out of vision-enrichment output before it reaches any in-memory buffer.
The single most important of these is :func:`hash_and_strip_plate`,
which is the INGEST-TIME choke-point for the "no raw plate text in any
buffer" invariant. See its docstring for the full rationale.

Why ``compliance/`` and not ``services/``?
    ``compliance/`` is where reviewers (and auditors) expect to find the
    code that enforces privacy / retention / audit invariants. Keeping
    the plate scrub next to ``audit.py`` and ``retention.py`` makes the
    package's purpose legible from the directory tree alone.
"""

import logging

logger = logging.getLogger(__name__)


def hash_and_strip_plate(enrichment: dict) -> dict:
    """Convert raw plate_text/plate_state into a salted plate_hash in place.

    =========================================================================
    !!!  PRIVACY INVARIANT - READ THIS BEFORE CHANGING ANYTHING ABOVE  !!!
    -------------------------------------------------------------------------
    The dict returned by ``enrich_event()`` MUST NEVER contain raw plate
    text or raw plate state. This function is the INGEST-TIME choke-point
    that enforces that invariant.

    Why ingest, not egress?
        Every egress scrub leaves a window between "received from model"
        and "scrubbed before send" during which a raw plate can end up
        in a log line, a traceback, an in-memory event buffer, an SSE
        subscriber, a Slack thread cache, or the cloud publisher queue.
        By hashing at ingest we make it *impossible* for downstream code
        to see the raw string at all - privacy by construction.

    Defence in depth:
        ``server.py`` additionally performs a ``pop()`` scrub on the
        event dict before emission (belt-and-braces). That scrub is the
        backup. This function is the primary barrier - if you break it,
        downstream leaks become inevitable.

    If you add a new code path that calls a vision model and returns a
    plate, route it through here (or ``hash_plate``) before the value
    ever reaches any caller.
    =========================================================================

    Args
    ----
    enrichment : dict
        Dict from ``_merge_self_consistency`` / ``_validate`` - still
        contains raw ``plate_text`` and ``plate_state``. Mutated in place.

    Returns
    -------
    dict
        The same dict with ``plate_text`` and ``plate_state`` removed and
        ``plate_hash`` inserted (when a non-null plate was present).
    """
    from backend.services.redact import hash_plate

    # ``dict.pop(key, default)`` removes and returns the value, or returns
    # the default if absent. We intentionally discard plate_state entirely -
    # even without the plate number, (state, color, make, time, location)
    # can re-identify a vehicle passing through the monitored intersection,
    # so state is treated as PII and never retained.
    plate_text = enrichment.pop("plate_text", None)
    enrichment.pop("plate_state", None)  # state narrows identity; treat as PII
    digest = hash_plate(plate_text)
    if digest:
        enrichment["plate_hash"] = digest
    return enrichment


# Backwards-compatibility alias. The function lived in ``services/llm.py``
# under a leading-underscore name for most of the project's life; anything
# that imports it by that name (internal or external) must keep working.
_hash_and_strip_plate = hash_and_strip_plate
