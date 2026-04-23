"""Async event emission + feedback hook + event lookup.

Runs on the main asyncio loop — handed events from the perception thread
via ``asyncio.run_coroutine_threadsafe(emit_event(...), state.loop)``.

Fan-out responsibilities (egress side of the hot path):
    1. LLM enrichment + narration (parallel ``asyncio.gather``).
    2. Privacy defence-in-depth: strip plate_text/plate_state from
       the enrichment dict *after* ``enrich_event`` has already
       hashed + stripped them at the LLM boundary.
    3. Append to the capped recent-events rolling buffer.
    4. Update the driver-safety registry.
    5. SSE broadcast to every live subscriber (via broadcast.py's
       same pattern — snapshot-iterate + put_nowait).
    6. Slack tier-dispatch — ``slack_notify`` itself decides channel
       + mention level from event.risk_level; we only pass the redacted
       public thumbnail so raw pixels never leave the edge.
    7. Active-learning sampler (opt-in).
    8. Edge-to-cloud batched publish (HMAC-signed, see
       ``backend/integrations/edge_publisher.py``).

Extracted from ``server.py`` (step 7).

UI connection
-------------
Page: [AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx) and
       [MonitoringPage.tsx](frontend/src/features/monitoring/MonitoringPage.tsx)
UI element: No direct UI — this is the final stop where a finished
       safety event gets enriched (LLM narration, ALPR), saved into the
       recent-events buffer, and pushed out to every connected browser.
       Each call to emit_event() is what makes a new incident card pop
       into the Monitoring feed and a new entry appear in the recent
       events list on the Admin page.
Data flow: emit_event() -> enrichment + audit log + recent-events
       buffer + Slack -> SSE broadcast (via broadcast.py) -> consumed by
       useEvents hook -> rendered as a new incident card on
       MonitoringPage and as a recent-events entry on AdminPage.
"""

import asyncio
from pathlib import Path

from backend.compliance import audit
from backend.config import ALPR_MODE, MAX_RECENT_EVENTS, PER_SOURCE_METADATA, THUMBS_DIR
from backend.integrations.slack import notify_event as slack_notify, slack_configured
from backend.logging import get_logger
from backend.perception.risk import _none_coro
from backend.services.drift import drift_warning_message
from backend.services.llm import enrich_event, narrate_event
from backend.services.registry import road_registry
from backend.state import state

log = get_logger(__name__)


def find_event(event_id: str) -> dict | None:
    """Locate an event by id in the recent-events buffer.

    Searches newest-first (``reversed``) because the most recent events
    are the ones an operator is likely querying. Bounded by
    ``MAX_RECENT_EVENTS`` — older events are evicted and must be fetched
    from the cloud store if needed.

    Args:
        event_id: The ``evt_...`` id produced by ``flush_episode``.

    Returns:
        The event dict if found, else ``None``.

    Privacy note:
        The returned dict is the post-enrichment version — no
        ``plate_text`` / ``plate_state`` fields are ever stored in the
        buffer (stripped at ingest in ``services/llm.py::enrich_event``
        and again defensively in ``emit_event`` below).
    """
    return state.find_recent_event(event_id)


async def emit_event(event: dict, internal_thumb_name: str) -> None:
    """Runs on the main asyncio loop. Narrates + enriches (parallel), then broadcasts.

    ALPR runs against the *internal* (unredacted) thumbnail because we need
    the plate text to hash it. The raw plate string is then discarded —
    only the salted hash survives into the egress payload. This is the
    key compliance boundary: plate text never reaches Slack, the SSE feed,
    or the recent-events buffer.

    Args:
        event: The typed event dict built by ``flush_episode``. Mutated
            in-place to add ``narration``, optional ``enrichment``, and
            ``perception_state`` / ``enrichment_skipped`` flags.
        internal_thumb_name: Basename of the unredacted JPEG on disk —
            passed to ``enrich_event`` so it can feed pixels to the
            optional external ALPR provider.

    Side effects:
        * Appends to ``state.recent_events`` (capped rolling buffer).
        * Updates ``road_registry`` (per-vehicle event counts + score).
        * Fans out to all SSE subscribers.
        * Fires Slack notification against the redacted thumbnail.
        * Optionally samples for active learning.
        * Optionally enqueues to the edge -> cloud publisher.

    Privacy notes:
        * ``internal_thumb_name`` is the unredacted JPEG and is used
          ONLY for ALPR pixel input; it is never referenced in any
          broadcast payload. The event's ``thumbnail`` field always
          points to the ``_public`` (face+plate-blurred) variant.
        * ``enrich_event`` in ``services/llm.py`` already strips
          ``plate_text``/``plate_state`` at the LLM boundary — the
          ``pop()`` calls below are defence-in-depth for any future
          alternative enrichment backend.
    """
    # Resolve the two thumbnail paths up front. ``internal_path`` is
    # used ONLY for ALPR pixel input; ``public_path`` is what Slack/SSE
    # consumers reference.
    internal_path = THUMBS_DIR / internal_thumb_name
    public_path = THUMBS_DIR / Path(event["thumbnail"]).name

    # Three skip paths for the vision call:
    #   (a) policy: ALPR disabled unless ROAD_ALPR_MODE=third_party.
    #       Default is ``off`` — no external ALPR call, ever. This is a
    #       deployment-wide posture (visible via /api/settings) and is
    #       NOT stamped onto each event: doing so would attach a constant
    #       banner to every card in the default posture, drowning the
    #       per-event signals below.
    #   (b) perception is degraded — low-SNR image, money wasted.
    #   (c) low-risk events — weekly-batch review SLA, ALPR adds little value.
    policy_skip = ALPR_MODE != "third_party"
    # BE-D1: resolve the slot that PRODUCED this event so perception
    # metadata is attributed to the right camera.
    source_id = event.get("source_id") or state.PRIMARY_ID
    event_slot = state.slots.get(source_id) or state.primary_slot
    slot_resolution_method = (
        "event_slot"
        if PER_SOURCE_METADATA and event.get("source_id") and event["source_id"] in state.slots
        else "primary"
    )
    log.debug(
        "emit_event slot resolution",
        extra={
            "event_id": event.get("event_id"),
            "source_id": source_id,
            "slot_resolution_method": slot_resolution_method,
        },
    )
    quality_src = event_slot.quality if PER_SOURCE_METADATA else state.quality
    perception_skip = quality_src.risk_adjustment().get("skip_vision_enrichment", False)
    low_risk_skip = event.get("risk_level") == "low"
    skip_enrich = policy_skip or perception_skip or low_risk_skip
    event["perception_state"] = quality_src.state().get("state", "nominal")
    if perception_skip:
        event["enrichment_skipped"] = "perception_degraded"
    elif low_risk_skip:
        event["enrichment_skipped"] = "low_risk_event"

    # ``asyncio.gather`` runs both coroutines concurrently.
    # Narration ~= LLM summary; enrichment ~= ALPR hash + vehicle class.
    # ``_none_coro`` is a no-op coroutine used when we skip enrichment
    # so the gather shape stays identical.
    narrate_task = narrate_event(event)
    enrich_task = (
        enrich_event(event, internal_path) if not skip_enrich else _none_coro()
    )
    narration, enrichment = await asyncio.gather(narrate_task, enrich_task)
    if narration:
        event["narration"] = narration
    if enrichment:
        # PRIVACY INVARIANT (defence in depth): enrich_event() already
        # hashes plate at the LLM boundary so raw plate_text never reaches
        # this process. Re-pop here in case a caller ever wires up a
        # different enrichment source.
        enrichment.pop("plate_text", None)
        enrichment.pop("plate_state", None)
        event["enrichment"] = enrichment

    # Bounded rolling buffer — newest wins; old entries evicted past
    # MAX_RECENT_EVENTS so the process footprint stays flat.
    state.append_recent_event(event, MAX_RECENT_EVENTS)

    # Registry keeps per-vehicle rolling counters + decayed safety score;
    # drives the fleet dashboard.
    road_registry.record_event(event)

    # SSE fan-out (mirror of broadcast.py pattern): snapshot-iterate so
    # a concurrent disconnect can't mutate the iterated set; non-blocking
    # put_nowait so a stalled browser tab can't back-pressure the loop.
    for q in list(state.subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # Drop for that subscriber only; everyone else still gets it.
            pass

    # Slack gets the redacted (public) thumbnail — never the internal one.
    # ``slack_notify`` internally tier-dispatches by risk_level (e.g.
    # high -> @channel, medium -> default, low -> digest-only) and is
    # rate-limited there; fire-and-forget so egress latency doesn't
    # block this coroutine.
    asyncio.create_task(slack_notify(event, public_path))

    # Active-learning sampler decides whether this event is "interesting"
    # (e.g. near-threshold confidence) and stashes it for later review.
    # Errors are logged but never propagated — never fail the hot path.
    try:
        state.active_learner.maybe_sample(event)
    except Exception as exc:
        log.warning("active-learning sample failed: %s", exc)

    # Edge -> cloud publish: the publisher internally batches events +
    # signs each batch with HMAC (see integrations/edge_publisher.py).
    # We enqueue the payload + public thumbnail path; flush is handled
    # on a background task, so this await returns quickly.
    if state.edge_publisher.enabled():
        try:
            await state.edge_publisher.enqueue(event, public_path)
        except Exception as exc:
            log.warning("edge enqueue failed: %s", exc)


async def on_feedback(record: dict, matched: dict | None) -> None:
    """Runs after each /api/feedback POST.

    - Writes an audit-log entry so every operator verdict is reviewable.
    - Updates the driver-safety registry (fp/tp counters per vehicle).
    - If verdict=fp: pull the event into the active-learning pool so
      the labelled false-positive becomes training signal.
    - Recompute drift; if precision dropped past threshold, post a one-off
      Slack warning (rate-limited by DriftMonitor's internal state).

    Args:
        record: The feedback POST body — ``event_id``, ``verdict`` (``tp``
            / ``fp`` / ``unsure``), optional free-text ``note``.
        matched: The event dict found via ``find_event(event_id)``, or
            ``None`` if the event has already been evicted from the
            recent-events buffer.

    Side effects:
        * Appends to ``backend/compliance/audit`` log.
        * Mutates ``road_registry`` counters.
        * May enqueue to ``state.active_learner``.
        * May post a Slack digest if ``DriftMonitor`` triggers.
    """
    audit.log(
        "submit_feedback", record.get("event_id", "unknown"),
        detail={"verdict": record.get("verdict"), "note": record.get("note")},
    )
    vehicle_id = matched.get("vehicle_id") if isinstance(matched, dict) else None
    road_registry.record_feedback(
        record.get("event_id", ""), record.get("verdict", ""), vehicle_id
    )
    if record.get("verdict") == "fp" and matched is not None:
        try:
            state.active_learner.sample_disputed(matched, note=record.get("note"))
        except Exception as exc:
            log.warning("active-learning sample_disputed failed: %s", exc)

    try:
        report = state.drift.compute()
    except Exception as exc:
        log.warning("drift compute failed: %s", exc)
        return
    if not report.alert_triggered:
        return
    warning = drift_warning_message(report)
    if not warning or not slack_configured():
        return
    try:
        from backend.integrations.slack import _post_digest
        await _post_digest(
            title="Drift warning",
            summary=f"Precision {report.precision:.2f} over {report.window_size} labels",
            body=warning,
        )
    except Exception as exc:
        log.warning("drift slack warn failed: %s", exc)
