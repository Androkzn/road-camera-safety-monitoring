"""Perception hot path — runs in the ``StreamReader`` background thread.

CPU-bound YOLO + gate evaluation happens here. Results are handed to
the asyncio loop via ``asyncio.run_coroutine_threadsafe``; we never
block that loop with the heavy work.

See the gate order documented in :func:`on_frame` — each gate kills a
specific false-positive class. Do not short-circuit without running
``tests/test_core.py``.

Extracted from ``server.py`` (step 7). Behaviour unchanged.
"""

import asyncio
import time

import cv2

from road_safety.config import EPISODE_IDLE_FLUSH_SEC, PAIR_COOLDOWN_SEC
from road_safety.core.detection import (
    VEHICLE_CLASSES,
    VEHICLE_INTER_DISTANCE_GATE_M,
    detect_frame,
    estimate_distance_m,
    estimate_distances_batch,
    estimate_inter_distance_m,
    estimate_pair_ttc,
    estimate_ttc_sec,
    find_interactions,
    tracks_converging,
)
from road_safety.core.orientation_policy import classify_event as _orientation_classify
from road_safety.core.validator import ValidatorJob
from road_safety.logging import get_logger
from road_safety.perception.broadcast import (
    broadcast_admin_detections,
    broadcast_perception,
)
from road_safety.perception.episode_emit import flush_episode
from road_safety.perception.risk import classify_with_scene, pair_key
from road_safety.rendering.frame import render_annotated_frame
from road_safety.state import Episode, StreamSlot, state

log = get_logger(__name__)


def make_on_frame(slot: StreamSlot):
    """Return a thread-safe ``on_frame(wall_ts, frame)`` closure for ``slot``.

    Each StreamReader needs its own callback that knows which slot it
    belongs to. The closure binds ``slot`` so the per-source perception
    state (quality, scene, ego, episodes…) updates correctly without
    crossing wires between cameras.
    """

    def _cb(wall_ts: float, frame) -> None:
        on_frame(slot, wall_ts, frame)

    return _cb


def on_frame(slot: StreamSlot, wall_ts: float, frame) -> None:
    """Perception hot path — runs in the StreamReader background thread.

    CPU-bound YOLO + gate evaluation happens here. Results are handed to
    the asyncio loop via ``asyncio.run_coroutine_threadsafe``; we never
    block that loop with the heavy work.

    Args:
        slot: The ``StreamSlot`` whose reader produced this frame. All
            per-source perception state (quality, scene, ego, episodes,
            track history, frame buffer) is read/written via ``slot.X``.
        wall_ts: Wall-clock timestamp (``time.time()``) when the frame
            was captured by the stream reader.
        frame: Raw BGR numpy image. This buffer is shared with the reader —
            we must not hold references to it beyond the call; ``frame.copy()``
            when we need to stash a peak.

    GATE ORDER (DO NOT SHORT-CIRCUIT — each kills a specific FP class):

        1. ``detect_frame``            — YOLOv8 + ByteTrack tracked detection.
        2. ``QualityMonitor.observe``  — night/rain/glare/dirty-lens detector;
                                         yields multipliers that tighten
                                         thresholds when perception is poor.
        3. ``EgoMotionEstimator``      — optical-flow ego speed proxy.
        4. ``SceneContextClassifier``  — urban / highway / parking tag;
                                         produces ``AdaptiveThresholds`` so
                                         65mph highway doesn't reuse city
                                         numbers.
        5. ``TrackHistory.update``     — per-track trailing window for
                                         multi-frame TTC.
        6. ``find_interactions``       — candidate pairs (person-vehicle,
                                         vehicle-vehicle close, etc.).
        7. Depth gate (vehicle-vehicle) — reject pairs > VEHICLE_INTER_DISTANCE_GATE_M
                                         apart in 3D even if bboxes overlap.
        8. Convergence gate             — reject parallel / same-direction
                                         traffic (``tracks_converging``).
        9. Ego-relative motion gate     — require at least one track to be
                                         approaching in ego-relative space;
                                         otherwise TTC is bbox noise.
       10. Pair TTC (fallback: per-object) — SSAM-style closing-rate TTC.
       11. Approach-required TTC scrub — if no track is approaching, discard
                                         the TTC value (keep distance gates).
       12. Quality-adjusted classification — divide by QualityMonitor
                                         multipliers, classify with scene.
       13. Per-type floors             — pedestrian_proximity must clear "low".
       14. Cooldown check              — ``pair_cooldown`` mutes recently-
                                         emitted pairs until they clear.
       15. Episode open / update       — aggregate across frames.
       16. Idle-flush                  — emit ONE event when a pair hasn't
                                         been seen for ``EPISODE_IDLE_FLUSH_SEC``.
    """
    # Guard against callbacks firing before ``lifespan`` finished wiring
    # the model / loop. Skipping early is harmless — next frame retries.
    if state.model is None or state.loop is None:
        return

    # Stash the raw frame reference so the polling endpoint can encode it
    # on demand if no annotated JPEG is cached yet.
    slot._latest_raw_frame = frame

    # ----- Detection-disabled bypass -----
    # Operator unchecked the "detection" toggle for this slot.
    if not slot.detection_enabled:
        if not slot.has_viewers():
            return
        try:
            ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                with slot._frame_lock:
                    slot._annotated_jpeg = jpeg.tobytes()
                    slot._frame_detections = []
                    slot._frame_ts = wall_ts
        except Exception as exc:
            log.warning("raw frame encode failed (%s): %s", slot.source_id, exc)
        return

    # ----- Gate 1: tracked detection (YOLO + ByteTrack) -----
    _t0 = time.perf_counter()
    detections = detect_frame(state.model, frame)
    slot.record_stage_ms("yolo", (time.perf_counter() - _t0) * 1000.0)
    frame_h = frame.shape[0]
    frame_w = frame.shape[1]

    # ----- Shadow-mode validator tee (sampled) -----
    if state.validator is not None and state.loop is not None:
        if state.validator.should_sample(slot.source_id, wall_ts):
            state.loop.call_soon_threadsafe(
                state.validator.enqueue,
                ValidatorJob(
                    kind="sampled",
                    slot_id=slot.source_id,
                    wall_ts=wall_ts,
                    frame=frame.copy(),
                    primary_detections=list(detections),
                    calibration=slot.calibration,
                ),
            )

    # ----- Gate 2: perception-quality observer -----
    _t0 = time.perf_counter()
    slot.quality.observe_frame(frame, detections, wall_ts)
    adj = slot.quality.risk_adjustment()
    qstate = slot.quality.state()
    slot.record_stage_ms("quality", (time.perf_counter() - _t0) * 1000.0)
    if qstate["state"] != slot.last_perception_state and state.loop is not None:
        slot.last_perception_state = qstate["state"]
        asyncio.run_coroutine_threadsafe(broadcast_perception(qstate, slot), state.loop)

    # ----- Gate 3: ego-motion estimation -----
    _t0 = time.perf_counter()
    try:
        ego_flow = slot.ego.update(frame, detections, wall_ts)
        slot.record_stage_ms("ego", (time.perf_counter() - _t0) * 1000.0)
    except Exception as exc:
        log.warning("ego-motion update failed (%s): %s", slot.source_id, exc)
        ego_flow = None
    slot.last_ego_flow = ego_flow

    # ----- Gate 4: scene context + adaptive thresholds -----
    if ego_flow is not None and ego_flow.confidence >= 0.4:
        speed_proxy = ego_flow.speed_proxy_mps
    else:
        speed_proxy = None
    _t0 = time.perf_counter()
    slot.scene.observe(detections, wall_ts, speed_proxy_mps=speed_proxy)
    scene_ctx = slot.scene.classify()
    slot.last_scene_ctx = scene_ctx
    thr = slot.scene.adaptive_thresholds(scene_ctx)
    slot.record_stage_ms("scene", (time.perf_counter() - _t0) * 1000.0)

    # ----- Gate 5: update per-track history -----
    live_ids: set[int] = set()
    for det in detections:
        if det.track_id is not None:
            live_ids.add(det.track_id)
            slot.track_history.update(det, wall_ts)
    slot.track_history.prune(live_ids, wall_ts)

    # ----- Gate 6: candidate interaction generation -----
    interactions = find_interactions(detections)
    seen_pairs_this_frame: set[tuple] = set()

    for event_type, a, b, distance_px in interactions:
        hist_a = slot.track_history.samples(a.track_id)
        hist_b = slot.track_history.samples(b.track_id)

        dist_m = estimate_inter_distance_m(a, b, frame_h, calibration=slot.calibration)
        if dist_m is None:
            cal = slot.calibration
            skip_ground = cal.orientation == "side"
            for sub in (a, b):
                cand = estimate_distance_m(
                    sub, frame_h,
                    focal_px=cal.focal_px,
                    height_m=cal.height_m,
                    horizon_frac=cal.horizon_frac,
                    offset_m=cal.bumper_offset_m,
                    skip_ground_plane=skip_ground,
                )
                if cand is not None and (dist_m is None or cand < dist_m):
                    dist_m = cand

        # ----- Gate 7 + 8: depth + convergence (vehicle-vehicle only) -----
        if event_type == "vehicle_close_interaction":
            if dist_m is not None and dist_m > VEHICLE_INTER_DISTANCE_GATE_M:
                continue
            if not tracks_converging(hist_a, hist_b):
                continue

        # ----- Gate 9: ego-relative motion -----
        approaching_a = approaching_b = False
        if ego_flow is not None:
            try:
                rm_a = slot.ego.relative_motion(a.track_id, a, ego_flow, slot.track_history)
                rm_b = slot.ego.relative_motion(b.track_id, b, ego_flow, slot.track_history)
                approaching_a = bool(rm_a and rm_a.approaching)
                approaching_b = bool(rm_b and rm_b.approaching)
            except Exception as exc:
                log.debug("relative_motion failed: %s", exc)
        any_approaching = approaching_a or approaching_b

        # ----- Gate 10: pair TTC (fallback: per-object) -----
        ttc = estimate_pair_ttc(hist_a, hist_b)
        if ttc is None:
            for sub in (a, b):
                hist = slot.track_history.samples(sub.track_id)
                cand = estimate_ttc_sec(hist)
                if cand is not None and (ttc is None or cand < ttc):
                    ttc = cand

        # ----- Gate 11: approach-required TTC scrub -----
        if ttc is not None and ego_flow is not None and not any_approaching:
            ttc = None

        # ----- Gate 12: quality-adjusted classification -----
        eff_ttc = ttc / adj["ttc_multiplier"] if ttc is not None else None
        eff_px = distance_px / adj["pixel_dist_multiplier"]
        ego_speed_mps = ego_flow.speed_proxy_mps if ego_flow is not None else None
        risk = classify_with_scene(
            eff_ttc, dist_m, eff_px, thr,
            ego_speed_mps=ego_speed_mps,
            any_track_approaching=any_approaching,
        )
        # ----- Gate 13: per-type floor -----
        if event_type == "pedestrian_proximity" and risk == "low":
            continue

        # ----- Gate 13.5: orientation policy (SAE J3063) -----
        policy_decision = _orientation_classify(
            calibration=slot.calibration,
            event_type=event_type,
            primary=a,
            secondary=b,
            frame_w=frame_w,
            frame_h=frame_h,
            ego=ego_flow,
            track_history=slot.track_history,
        )
        if not policy_decision.emit:
            log.debug(
                "event suppressed by orientation policy: slot=%s type=%s reason=%s",
                slot.source_id, event_type, policy_decision.reason,
            )
            continue

        # ----- Gate 14: cooldown check -----
        key = pair_key(event_type, a, b)
        if key is None:
            key = (event_type, "no_track", int(wall_ts))

        cooldown_until = slot.pair_cooldown.get(key, 0.0)
        if wall_ts < cooldown_until:
            continue

        # ----- Gate 15: episode open / update -----
        seen_pairs_this_frame.add(key)
        ep = slot.episodes.get(key)
        if ep is None:
            ep = Episode(event_type, key, wall_ts)
            ep.camera_orientation = slot.calibration.orientation
            ep.event_taxonomy = policy_decision.taxonomy
            ep.display_event_type = policy_decision.display_event_type
            ep.policy_reason = policy_decision.reason
            slot.episodes[key] = ep
        ep.update(frame, detections, a, b, distance_px, ttc, dist_m, risk, wall_ts)

    # ----- Gate 16: idle-flush episodes -----
    for key in list(slot.episodes.keys()):
        ep = slot.episodes[key]
        if key in seen_pairs_this_frame:
            continue
        if wall_ts - ep.last_seen_at >= EPISODE_IDLE_FLUSH_SEC:
            flush_episode(slot, ep, wall_ts)
            slot.episodes.pop(key, None)
            slot.pair_cooldown[key] = wall_ts + PAIR_COOLDOWN_SEC

    # ----- Admin video feed + detections broadcast -----
    try:
        has_viewers = slot.has_viewers()
        cam_cal = slot.calibration
        cam_axis = "lateral" if cam_cal.orientation == "side" else "range"
        per_det_distances: list[float | None] = estimate_distances_batch(
            detections, frame_h, frame, calibration=cam_cal,
        )
        jpeg_bytes = (
            render_annotated_frame(
                frame, detections, interactions, distances_m=per_det_distances
            )
            if has_viewers else None
        )
        det_snapshot = [
            {
                "cls": d.cls, "conf": round(d.conf, 3),
                "track_id": d.track_id,
                "bbox": [d.x1, d.y1, d.x2, d.y2],
                "distance_m": (
                    round(per_det_distances[i], 1)
                    if per_det_distances[i] is not None else None
                ),
                "distance_axis": cam_axis,
            }
            for i, d in enumerate(detections)
        ]
        with slot._frame_lock:
            if jpeg_bytes is not None:
                slot._annotated_jpeg = jpeg_bytes
            slot._frame_detections = det_snapshot
            slot._frame_ts = wall_ts

        if state.loop is not None:
            reader = slot.reader
            playback_pos_sec, playback_duration_sec = (
                reader.playback_position() if reader is not None else (0.0, 0.0)
            )
            msg = {
                "ts": round(wall_ts, 3),
                "source_id": slot.source_id,
                "source_name": slot.name,
                "detections": len(detections),
                "persons": sum(1 for d in detections if d.cls == "person"),
                "vehicles": sum(1 for d in detections if d.cls in VEHICLE_CLASSES),
                "interactions": len(interactions),
                "objects": det_snapshot,
                "playback_pos_sec": round(playback_pos_sec, 3),
                "playback_duration_sec": round(playback_duration_sec, 3),
            }
            asyncio.run_coroutine_threadsafe(
                broadcast_admin_detections(msg), state.loop
            )
    except Exception as exc:
        log.warning("annotated frame failed (%s): %s", slot.source_id, exc)
