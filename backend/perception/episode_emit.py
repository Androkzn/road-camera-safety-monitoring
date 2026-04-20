"""Episode → typed-event materialisation.

Called from the perception thread (inside ``on_frame``'s idle-flush loop).
Writes dual thumbnails to disk and schedules :func:`emit_event` on the
asyncio loop.

Extracted from ``server.py`` (step 7).
"""

import asyncio
import time
from datetime import datetime, timezone

from backend.config import DEFAULT_STREAM_SOURCE as DEFAULT_SOURCE, THUMBS_DIR
from backend.core.detection import build_event_summary
from backend.core.stream import display_video_id
from backend.core.validator import ValidatorJob
from backend.perception.emit import emit_event
from backend.services.redact import public_thumbnail_name, write_thumbnails
from backend.state import (
    RESOLVED_DRIVER_ID,
    RESOLVED_ROAD_ID,
    RESOLVED_VEHICLE_ID,
    Episode,
    StreamSlot,
    state,
)


def flush_episode(slot: StreamSlot, ep: Episode, wall_ts: float) -> None:
    """Materialise an episode's peak frame into an Event and hand off to the
    asyncio side for LLM enrichment + egress.

    The peak risk is downgraded by ``Episode.final_risk()`` if it lacks
    sustained support — a single high-risk frame in an otherwise calm
    episode is treated as a transient and emitted at the lower tier. This
    rejects single-frame TTC spikes from bbox jitter without losing the
    peak-frame thumbnail for review.

    Side effects:
        * Writes two JPEGs under ``THUMBS_DIR``:
            - ``<event_id>.jpg``        (internal, unredacted — DSAR-gated)
            - ``<event_id>_public.jpg`` (redacted: faces + plates blurred)
          Shared channels (SSE, Slack, cloud) reference ONLY the public copy.
        * Schedules ``emit_event`` on the asyncio loop.
        * Sets ``ep.emitted = True`` so repeated flush calls are no-ops.

    Args:
        slot: The ``StreamSlot`` whose perception thread observed the episode.
        ep: The ``Episode`` being flushed.
        wall_ts: Current wall-clock timestamp (unused inside the body but
            kept for call-site symmetry with the idle-flush check).
    """
    if ep.emitted or ep.peak_frame is None:
        return
    ep.emitted = True

    # BE-D5.A: measure the emission cost on the perception thread. This
    # covers thumbnail writes (the heaviest step), event-dict materialization
    # and the ``run_coroutine_threadsafe`` handoff to the asyncio loop.
    _emit_t0 = time.perf_counter()

    # Sustained-risk downgrade — see Episode.final_risk().
    final_risk = ep.final_risk()
    risk_demoted = final_risk != ep.peak_risk

    # Event id format: ``evt_<ms-since-epoch>_<4-digit-counter>`` — roughly
    # sortable and globally unique per process.
    state.event_counter += 1
    event_id = f"evt_{int(ep.started_at * 1000)}_{state.event_counter:04d}"
    internal_name = f"{event_id}.jpg"
    public_name = public_thumbnail_name(internal_name)

    # PRIVACY INVARIANT: ``write_thumbnails`` is the ONLY place both JPEGs
    # are produced. The internal copy stays on disk behind DSAR-gating;
    # the public copy has faces + plates blurred.
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    write_thumbnails(
        ep.peak_frame,
        ep.peak_detections,
        ep.peak_primary,
        ep.peak_secondary,
        THUMBS_DIR / internal_name,
        THUMBS_DIR / public_name,
    )

    a, b = ep.peak_primary, ep.peak_secondary
    stream_t = ep.started_at - (slot.reader.started_at if slot.reader else ep.started_at)
    pair_ids = [tid for tid in (a.track_id, b.track_id) if tid is not None]
    duration_sec = round(ep.last_seen_at - ep.started_at, 2)

    scene_ctx = slot.last_scene_ctx
    ego = slot.last_ego_flow
    # ===== Typed event dict — the canonical wire format =====
    # Every field here is part of the public contract with downstream
    # consumers (dashboard, Slack, cloud). If you rename a field, grep
    # for it in frontend/ and cloud/ first.
    event = {
        "event_id": event_id,
        "source_id": slot.source_id,
        "source_name": slot.name,
        "vehicle_id": RESOLVED_VEHICLE_ID,
        "road_id": RESOLVED_ROAD_ID,
        "driver_id": RESOLVED_DRIVER_ID,
        "video_id": display_video_id(slot.original_source or DEFAULT_SOURCE),
        "timestamp_sec": round(stream_t, 2),
        "wall_time": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "event_type": ep.display_event_type or ep.event_type,
        "internal_event_type": ep.event_type,
        "risk_level": final_risk,
        "peak_risk_level": ep.peak_risk,
        "risk_demoted": risk_demoted,
        "risk_frame_counts": dict(ep.risk_frame_counts),
        "frame_count": ep.frame_count,
        "confidence": round(min(a.conf, b.conf), 3),
        "objects": sorted({a.cls, b.cls}),
        "track_ids": pair_ids,
        "episode_duration_sec": duration_sec,
        "camera_orientation": ep.camera_orientation,
        "event_taxonomy": ep.event_taxonomy,
        "policy_reason": ep.policy_reason,
        "ttc_sec": ep.peak_ttc,
        "distance_m": ep.peak_distance_m,
        "distance_px": round(ep.peak_distance_px, 1),
        "scene_context": (
            {
                "label": scene_ctx.label,
                "confidence": round(scene_ctx.confidence, 2),
                "speed_proxy_mps": (
                    round(scene_ctx.speed_proxy_mps, 2)
                    if scene_ctx.speed_proxy_mps is not None else None
                ),
                "reason": scene_ctx.reason,
            }
            if scene_ctx is not None else None
        ),
        "ego_flow": (
            {
                "speed_proxy_mps": round(ego.speed_proxy_mps, 2),
                "confidence": round(ego.confidence, 2),
            }
            if ego is not None else None
        ),
        "summary": build_event_summary(
            ep.event_type, a, b, ep.peak_distance_px, final_risk,
            ttc_sec=ep.peak_ttc, distance_m=ep.peak_distance_m,
            camera_orientation=ep.camera_orientation,
            event_taxonomy=ep.event_taxonomy,
        ),
        "narration": None,
        "thumbnail": f"thumbnails/{public_name}",
    }

    # Hand off to the asyncio loop — LLM enrichment + SSE broadcast + Slack
    # dispatch all happen there, not in this background thread.
    asyncio.run_coroutine_threadsafe(emit_event(event, internal_name), state.loop)
    slot.record_stage_ms("emit", (time.perf_counter() - _emit_t0) * 1000.0)

    # ----- Validator deep re-check of the peak frame -----
    if (
        state.validator is not None
        and state.loop is not None
        and ep.peak_frame is not None
    ):
        state.validator.mark_primary_event(slot.source_id, wall_ts)
        state.loop.call_soon_threadsafe(
            state.validator.enqueue,
            ValidatorJob(
                kind="episode",
                slot_id=slot.source_id,
                wall_ts=wall_ts,
                frame=ep.peak_frame,
                primary_detections=list(ep.peak_detections),
                primary_event=event,
                calibration=slot.calibration,
            ),
        )
