"""Async event emission + feedback hook + event lookup.

Runs on the main asyncio loop — handed events from the perception thread
via ``asyncio.run_coroutine_threadsafe(emit_event(...), state.loop)``.

Extracted from ``server.py`` (step 7).
"""

import asyncio
from pathlib import Path

from road_safety.compliance import audit
from road_safety.config import ALPR_MODE, MAX_RECENT_EVENTS, PER_SOURCE_METADATA, THUMBS_DIR
from road_safety.integrations.slack import notify_event as slack_notify, slack_configured
from road_safety.logging import get_logger
from road_safety.perception.risk import _none_coro
from road_safety.services.drift import drift_warning_message
from road_safety.services.llm import enrich_event, narrate_event
from road_safety.services.registry import road_registry
from road_safety.state import state

log = get_logger(__name__)


def find_event(event_id: str) -> dict | None:
    """Locate an event by id in the recent-events buffer.

    Searches newest-first (``reversed``) because the most recent events
    are the ones an operator is likely querying.

    Args:
        event_id: The ``evt_...`` id produced by ``flush_episode``.

    Returns:
        The event dict if found, else ``None``.
    """
    for ev in reversed(state.recent_events):
        if ev.get("event_id") == event_id:
            return ev
    return None


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
    """
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

    state.recent_events.append(event)
    if len(state.recent_events) > MAX_RECENT_EVENTS:
        state.recent_events.pop(0)

    road_registry.record_event(event)

    for q in list(state.subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass

    # Slack gets the redacted (public) thumbnail — never the internal one.
    asyncio.create_task(slack_notify(event, public_path))

    try:
        state.active_learner.maybe_sample(event)
    except Exception as exc:
        log.warning("active-learning sample failed: %s", exc)

    if state.edge_publisher.enabled():
        try:
            await state.edge_publisher.enqueue(event, public_path)
        except Exception as exc:
            log.warning("edge enqueue failed: %s", exc)


async def on_feedback(record: dict, matched: dict | None) -> None:
    """Runs after each /api/feedback POST.

    - If verdict=fp: pull the event into the active-learning pool.
    - Recompute drift; if precision dropped past threshold, post a one-off
      Slack warning (rate-limited by DriftMonitor's internal state).
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
        from road_safety.integrations.slack import _post_digest
        await _post_digest(
            title="Drift warning",
            summary=f"Precision {report.precision:.2f} over {report.window_size} labels",
            body=warning,
        )
    except Exception as exc:
        log.warning("drift slack warn failed: %s", exc)
