"""Live safety review API.

Pulls a live stream, runs YOLO at 2 fps in a background thread, emits typed safety
events over Server-Sent Events with an LLM-generated one-line narration, and exposes
a RAG-backed copilot endpoint over a tiny statute/policy corpus.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import cv2
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from road_safety.logging import setup as setup_logging, get_logger

setup_logging()
log = get_logger(__name__)

from road_safety.config import (
    ALPR_MODE,
    DATA_DIR,
    DEFAULT_STREAM_SOURCE as DEFAULT_SOURCE,
    ADMIN_TOKEN,
    DSAR_TOKEN,
    DRIVER_ID,
    EPISODE_IDLE_FLUSH_SEC,
    LOCATION,
    ROAD_ID,
    MAX_RECENT_EVENTS,
    MODEL_PATH,
    PAIR_COOLDOWN_SEC,
    PUBLIC_THUMBS_REQUIRE_TOKEN,
    SCORE_DECAY_INTERVAL_SEC,
    SSE_REPLAY_COUNT,
    WATCHDOG_ENABLED,
    WATCHDOG_INTERVAL_SEC,
    STATIC_DIR,
    TARGET_FPS,
    THUMB_SIGNING_SECRET,
    THUMBS_DIR,
    VEHICLE_ID,
)
from road_safety.core.detection import (
    LOW_SPEED_FLOOR_MPS,
    VEHICLE_CLASSES,
    VEHICLE_INTER_DISTANCE_GATE_M,
    TrackHistory,
    bbox_edge_distance,
    build_event_summary,
    classify_risk,
    detect_frame,
    estimate_distance_m,
    estimate_inter_distance_m,
    estimate_pair_ttc,
    estimate_ttc_sec,
    find_interactions,
    load_model,
    tracks_converging,
)
from road_safety.core.stream import StreamReader, resolve_hls
from road_safety.core.quality import QualityMonitor
from road_safety.core.context import SceneContextClassifier
from road_safety.core.egomotion import EgoMotionEstimator
from road_safety.services.llm import chat as llm_chat, enrich_event, llm_configured, narrate_event
from road_safety.services.llm_obs import observer as llm_observer
from road_safety.services.redact import hash_plate, public_thumbnail_name, write_thumbnails
from road_safety.services.agents import AgentExecutor, run_coaching_agent, run_investigation_agent, run_report_agent
from road_safety.services.registry import road_registry
from road_safety.services.drift import ActiveLearningSampler, DriftMonitor, drift_warning_message
from road_safety.services.digest import start_schedulers as start_digest_schedulers
from road_safety.integrations.slack import notify_event as slack_notify, slack_configured
from road_safety.integrations.edge_publisher import EdgePublisher
from road_safety.api.feedback import mount as mount_feedback_routes
from road_safety.compliance import audit
from road_safety.compliance.retention import retention_loop, run_sweep as retention_sweep
from road_safety.services.test_runner import run_state as test_run_state, start_test_run
from road_safety.services.watchdog import Watchdog, tail as watchdog_tail, stats as watchdog_stats, delete_findings as watchdog_delete, delete_findings_by_id as watchdog_delete_by_id
from road_safety.security import require_bearer_token


# Resolved fleet identity — every emitted event MUST carry a non-empty
# vehicle_id / road_id / driver_id or downstream fleet aggregation is
# broken (events appear as "unidentified"). If the operator didn't set the
# env vars, fall back to a stable hostname-derived default and warn loudly
# at startup so the deployment is obviously misconfigured instead of
# silently producing unattributable events.
def _resolve_identity() -> tuple[str, str, str, list[str]]:
    import socket
    host = socket.gethostname().split(".")[0] or "unknown"
    missing: list[str] = []
    vid = VEHICLE_ID
    rid = ROAD_ID
    did = DRIVER_ID
    if not vid:
        vid = f"unidentified_vehicle_{host}"
        missing.append("ROAD_VEHICLE_ID")
    if not rid:
        rid = f"unidentified_road_{host}"
        missing.append("ROAD_ID")
    if not did:
        did = f"unidentified_driver_{host}"
        missing.append("ROAD_DRIVER_ID")
    return vid, rid, did, missing


RESOLVED_VEHICLE_ID, RESOLVED_ROAD_ID, RESOLVED_DRIVER_ID, _MISSING_IDENTITY = (
    _resolve_identity()
)


# Sustained-risk requirements for episode emission. A single high-risk frame
# in an otherwise calm episode is almost always a transient detection artefact;
# real conflicts produce ≥ 2 high-risk frames over ≥ 1 s of episode duration.
MIN_HIGH_RISK_FRAMES = 2
MIN_MEDIUM_RISK_FRAMES = 2
MIN_HIGH_RISK_EPISODE_SEC = 1.0


class Episode:
    """An ongoing interaction between a specific *pair* of tracked objects.

    The episode is held open while the pair stays in view, accumulating the
    worst risk and tightest distance across its lifetime, plus per-risk-level
    frame counts. On flush, the peak risk is **downgraded** if it lacks
    sustained support — a single high-risk frame is treated as a transient and
    reported as medium; a single medium frame becomes low.

    The episode model suppresses per-frame detection-artefact spam by
    requiring sustained evidence before promoting a peak risk into the
    emitted event.
    """

    def __init__(self, event_type: str, pair: tuple[int, int], started_at: float):
        self.event_type = event_type
        self.pair = pair
        self.started_at = started_at
        self.last_seen_at = started_at
        self.peak_frame = None
        self.peak_detections: list = []
        self.peak_primary = None
        self.peak_secondary = None
        self.peak_distance_px: float = float("inf")
        self.peak_ttc: float | None = None
        self.peak_distance_m: float | None = None
        self.peak_risk: str = "low"
        self.frame_count: int = 0
        self.risk_frame_counts: dict[str, int] = {"low": 0, "medium": 0, "high": 0}
        self.emitted: bool = False

    def update(
        self,
        frame,
        detections,
        a,
        b,
        distance_px: float,
        ttc: float | None,
        dist_m: float | None,
        risk: str,
        now: float,
    ) -> None:
        self.last_seen_at = now
        self.frame_count += 1
        if risk in self.risk_frame_counts:
            self.risk_frame_counts[risk] += 1
        risk_rank = {"low": 0, "medium": 1, "high": 2}
        is_new_peak = (
            risk_rank[risk] > risk_rank[self.peak_risk]
            or (risk == self.peak_risk and distance_px < self.peak_distance_px)
        )
        if is_new_peak or self.peak_frame is None:
            self.peak_frame = frame.copy()
            self.peak_detections = list(detections)
            self.peak_primary = a
            self.peak_secondary = b
            self.peak_distance_px = distance_px
            self.peak_ttc = ttc
            self.peak_distance_m = dist_m
            self.peak_risk = risk

    def final_risk(self) -> str:
        """Sustained-risk-aware downgrade.

        A peak risk only stands if supported by enough frames AND enough
        episode duration. Otherwise it is downgraded one level.
        """
        duration = max(self.last_seen_at - self.started_at, 0.0)
        high = self.risk_frame_counts.get("high", 0)
        med = self.risk_frame_counts.get("medium", 0)

        if self.peak_risk == "high":
            if high >= MIN_HIGH_RISK_FRAMES and duration >= MIN_HIGH_RISK_EPISODE_SEC:
                return "high"
            # Demote to medium if the medium support is there, else low.
            if (high + med) >= MIN_MEDIUM_RISK_FRAMES:
                return "medium"
            return "low"
        if self.peak_risk == "medium":
            if (high + med) >= MIN_MEDIUM_RISK_FRAMES:
                return "medium"
            return "low"
        return "low"


class LiveState:
    def __init__(self):
        self.model = None
        self.reader: StreamReader | None = None
        self.source_label: str = DEFAULT_SOURCE
        self.loop: asyncio.AbstractEventLoop | None = None
        self.recent_events: list[dict] = []
        self.subscribers: set[asyncio.Queue] = set()
        self.event_counter = 0
        self.track_history = TrackHistory()
        self.episodes: dict[tuple[int, int], Episode] = {}
        self.pair_cooldown: dict[tuple[int, int], float] = {}
        self.quality = QualityMonitor()
        self.last_perception_state: str | None = None
        # Ego-motion, scene context, drift monitor, active-learning sampler,
        # edge publisher, and agent executor.
        self.ego = EgoMotionEstimator()
        self.scene = SceneContextClassifier()
        self.last_ego_flow = None
        self.last_scene_ctx = None
        self.drift = DriftMonitor()
        self.active_learner = ActiveLearningSampler()
        self.edge_publisher = EdgePublisher()
        # Agent executor is wired after lifespan sets event_lookup.
        self.agent_executor: AgentExecutor | None = None
        # Admin video feed: latest annotated JPEG bytes + per-frame detection snapshot.
        self._frame_lock = threading.Lock()
        self._annotated_jpeg: bytes | None = None
        self._frame_detections: list[dict] = []
        self._frame_ts: float = 0.0
        self.admin_detection_subscribers: set[asyncio.Queue] = set()


state = LiveState()


def _require_admin(request: Request, realm: str = "admin") -> None:
    require_bearer_token(
        request,
        ADMIN_TOKEN,
        realm=realm,
        env_var="ROAD_ADMIN_TOKEN",
    )


async def _none_coro():
    return None


def _thumb_token(name: str, expiry: int) -> str:
    mac = hmac.new(
        THUMB_SIGNING_SECRET.encode("utf-8"),
        f"{name}.{expiry}".encode("utf-8"),
        hashlib.sha256,
    )
    return mac.hexdigest()[:32]


def _valid_thumb_request(name: str, request: Request) -> bool:
    if not PUBLIC_THUMBS_REQUIRE_TOKEN:
        return True
    if not THUMB_SIGNING_SECRET:
        return False
    exp_raw = request.query_params.get("exp")
    token = (request.query_params.get("token") or "").strip()
    if not exp_raw or not token:
        return False
    try:
        exp = int(exp_raw)
    except ValueError:
        return False
    now = int(time.time())
    if exp < now:
        return False
    # Reject far-future signatures in case of leaked URLs.
    if exp > now + (24 * 60 * 60):
        return False
    expected = _thumb_token(name, exp)
    return hmac.compare_digest(expected, token)


async def _score_decay_loop(interval_sec: int) -> None:
    while True:
        try:
            await asyncio.sleep(interval_sec)
            road_registry.decay_scores()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("score decay loop failed: %s", exc)


def _pair_key(event_type: str, a, b) -> tuple | None:
    """Canonical pair key for an interaction. Returns None if either side has
    no track_id — in which case we fall back to type-level dedup."""
    if a.track_id is None or b.track_id is None:
        return None
    lo, hi = sorted((a.track_id, b.track_id))
    return (event_type, lo, hi)


def _classify_with_scene(
    ttc_sec,
    distance_m,
    fallback_px,
    thr,
    ego_speed_mps: float | None = None,
    any_track_approaching: bool = False,
) -> str:
    """Scene-adaptive risk classification with low-speed floor.

    Priority: TTC > distance > pixels. Highway widens TTC (more reaction
    time at speed); parking tightens it (close-quarters, slow).

    Low-speed floor: when ego is essentially stationary AND no track is
    actively approaching, risk is capped at 'medium'. Close-quarters
    proximity in stopped traffic is normal, not a conflict. A genuine
    approach by another moving object still upgrades the risk via
    `any_track_approaching`.
    """
    levels = []
    if ttc_sec is not None:
        if ttc_sec <= thr.ttc_high_sec:
            levels.append("high")
        elif ttc_sec <= thr.ttc_med_sec:
            levels.append("medium")
    if distance_m is not None:
        if distance_m <= thr.dist_high_m:
            levels.append("high")
        elif distance_m <= thr.dist_med_m:
            levels.append("medium")
    if ttc_sec is None and distance_m is None:
        if fallback_px <= 60:
            levels.append("high")
        elif fallback_px <= 180:
            levels.append("medium")

    risk = "low"
    if "high" in levels:
        risk = "high"
    elif "medium" in levels:
        risk = "medium"

    # Speed-aware floor: in low-speed regimes (red light, traffic jam,
    # parking), close-quarters proximity is normal. Cap at medium unless
    # there is independent evidence of approach (ego-motion residual).
    if (
        risk == "high"
        and ego_speed_mps is not None
        and ego_speed_mps < LOW_SPEED_FLOOR_MPS
        and not any_track_approaching
    ):
        return "medium"
    return risk


def _render_annotated_frame(frame, detections, interactions):
    """Draw bounding boxes and labels on a copy of the frame for the admin feed."""
    vis = frame.copy()
    color_map = {
        "person": (0, 220, 100),
        "car": (255, 160, 0),
        "truck": (255, 100, 0),
        "bus": (200, 80, 200),
        "motorcycle": (0, 180, 255),
    }
    for det in detections:
        color = color_map.get(det.cls, (200, 200, 200))
        cv2.rectangle(vis, (det.x1, det.y1), (det.x2, det.y2), color, 2)
        label = f"{det.cls} {det.conf:.0%}"
        if det.track_id is not None:
            label = f"#{det.track_id} {label}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(vis, (det.x1, det.y1 - th - 6), (det.x1 + tw + 4, det.y1), color, -1)
        cv2.putText(vis, label, (det.x1 + 2, det.y1 - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)

    for event_type, a, b, dist_px in interactions:
        cx_a, cy_a = int(a.center[0]), int(a.center[1])
        cx_b, cy_b = int(b.center[0]), int(b.center[1])
        line_color = (0, 0, 255) if event_type == "pedestrian_proximity" else (0, 165, 255)
        cv2.line(vis, (cx_a, cy_a), (cx_b, cy_b), line_color, 2, cv2.LINE_AA)
        mid_x, mid_y = (cx_a + cx_b) // 2, (cy_a + cy_b) // 2
        cv2.putText(vis, f"{int(dist_px)}px", (mid_x + 4, mid_y - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, line_color, 1, cv2.LINE_AA)

    _, jpeg = cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return jpeg.tobytes()


def _on_frame(wall_ts: float, frame) -> None:
    """Runs in the StreamReader background thread. CPU-bound YOLO happens here.

    Flow per frame:
      1. Tracked detection (ByteTrack) — stable track_ids across frames.
      2. Update TrackHistory so TTC can read multi-frame scale growth.
      3. For each interaction, open or update an Episode keyed by the pair of
         track_ids. Stash the peak-severity frame.
      4. Flush any episodes whose pair hasn't been seen for EPISODE_IDLE_FLUSH
         — they emit ONE event (the peak frame), then enter cooldown.
    """
    if state.model is None or state.loop is None:
        return

    detections = detect_frame(state.model, frame)
    frame_h = frame.shape[0]

    # Perception-quality monitor — observe every frame so degradations
    # (night, rain, glare, dirty lens) flip the pipeline into conservative mode.
    state.quality.observe_frame(frame, detections, wall_ts)
    adj = state.quality.risk_adjustment()
    qstate = state.quality.state()
    if qstate["state"] != state.last_perception_state and state.loop is not None:
        state.last_perception_state = qstate["state"]
        asyncio.run_coroutine_threadsafe(_broadcast_perception(qstate), state.loop)

    # Ego-motion: Farneback on masked background → ego flow vector + speed proxy.
    # Ego-motion lets downstream code tell "object approaching me" apart from
    # "I'm approaching a parked object." Also feeds scene context.
    try:
        ego_flow = state.ego.update(frame, detections, wall_ts)
    except Exception as exc:
        log.warning("ego-motion update failed: %s", exc)
        ego_flow = None
    state.last_ego_flow = ego_flow

    # Scene context: classify urban / highway / parking from rolling detection
    # density + ego speed. Thresholds adapt per scene so 65mph highway doesn't
    # reuse city-street numbers.
    # Only feed the speed proxy in when ego-flow confidence is high enough
    # that the median flow is reliable. Below this band (rain, wipers, low
    # texture, pure rotation) we let the classifier fall back to detection-
    # density rules rather than driving adaptive thresholds off a noisy
    # speed estimate — that's how "highway" mistakenly fires in parking lots
    # with reflective floors.
    if ego_flow is not None and ego_flow.confidence >= 0.4:
        speed_proxy = ego_flow.speed_proxy_mps
    else:
        speed_proxy = None
    state.scene.observe(detections, wall_ts, speed_proxy_mps=speed_proxy)
    scene_ctx = state.scene.classify()
    state.last_scene_ctx = scene_ctx
    thr = state.scene.adaptive_thresholds(scene_ctx)

    live_ids: set[int] = set()
    for det in detections:
        if det.track_id is not None:
            live_ids.add(det.track_id)
            state.track_history.update(det, wall_ts)
    state.track_history.prune(live_ids, wall_ts)

    interactions = find_interactions(detections)
    seen_pairs_this_frame: set[tuple] = set()

    for event_type, a, b, distance_px in interactions:
        hist_a = state.track_history.samples(a.track_id)
        hist_b = state.track_history.samples(b.track_id)

        # Inter-object distance (depth difference + lateral offset), not
        # single-object range-to-camera.
        dist_m = estimate_inter_distance_m(a, b, frame_h)
        if dist_m is None:
            for sub in (a, b):
                cand = estimate_distance_m(sub, frame_h)
                if cand is not None and (dist_m is None or cand < dist_m):
                    dist_m = cand

        # Depth-aware proximity for vehicle-vehicle pairs. Two cars more than
        # VEHICLE_INTER_DISTANCE_GATE_M apart in 3D are not a close interaction
        # even when their bboxes overlap in the image plane — perspective
        # overlap of distant objects is not collision risk.
        if event_type == "vehicle_close_interaction":
            if dist_m is not None and dist_m > VEHICLE_INTER_DISTANCE_GATE_M:
                continue
            # Convergence filter: reject parallel / same-direction traffic.
            if not tracks_converging(hist_a, hist_b):
                continue

        # Ego-relative motion gate. If neither track shows a positive approach
        # residual against the optical-flow ego-motion estimate, TTC from
        # bbox noise alone is not a conflict — discard it.
        approaching_a = approaching_b = False
        if ego_flow is not None:
            try:
                rm_a = state.ego.relative_motion(a.track_id, a, ego_flow, state.track_history)
                rm_b = state.ego.relative_motion(b.track_id, b, ego_flow, state.track_history)
                approaching_a = bool(rm_a and rm_a.approaching)
                approaching_b = bool(rm_b and rm_b.approaching)
            except Exception as exc:
                log.debug("relative_motion failed: %s", exc)
        any_approaching = approaching_a or approaching_b

        # Pair-wise TTC from closing rate between the two tracks (SSAM method).
        # Falls back to per-object scale-expansion TTC if pair TTC unavailable.
        ttc = estimate_pair_ttc(hist_a, hist_b)
        if ttc is None:
            for sub in (a, b):
                hist = state.track_history.samples(sub.track_id)
                cand = estimate_ttc_sec(hist)
                if cand is not None and (ttc is None or cand < ttc):
                    ttc = cand

        # If a TTC value passed the upstream gates but neither track shows
        # an approach residual, treat it as unreliable and discard. Distance
        # and edge-pixel gates still apply.
        if ttc is not None and ego_flow is not None and not any_approaching:
            ttc = None

        # Quality-adjusted classification: divide effective TTC / px to tighten
        # thresholds when perception is degraded (earlier triggers, more cautious).
        eff_ttc = ttc / adj["ttc_multiplier"] if ttc is not None else None
        eff_px = distance_px / adj["pixel_dist_multiplier"]
        ego_speed_mps = ego_flow.speed_proxy_mps if ego_flow is not None else None
        risk = _classify_with_scene(
            eff_ttc, dist_m, eff_px, thr,
            ego_speed_mps=ego_speed_mps,
            any_track_approaching=any_approaching,
        )
        if event_type == "pedestrian_proximity" and risk == "low":
            continue

        key = _pair_key(event_type, a, b)
        if key is None:
            # Untracked fallback — synthesise a per-frame key so we still
            # dedup within a short window without a stable pair identity.
            key = (event_type, "no_track", int(wall_ts))

        cooldown_until = state.pair_cooldown.get(key, 0.0)
        if wall_ts < cooldown_until:
            continue

        seen_pairs_this_frame.add(key)
        ep = state.episodes.get(key)
        if ep is None:
            ep = Episode(event_type, key, wall_ts)
            state.episodes[key] = ep
        ep.update(frame, detections, a, b, distance_px, ttc, dist_m, risk, wall_ts)

    # Idle-flush episodes that didn't show up in this frame.
    for key in list(state.episodes.keys()):
        ep = state.episodes[key]
        if key in seen_pairs_this_frame:
            continue
        if wall_ts - ep.last_seen_at >= EPISODE_IDLE_FLUSH_SEC:
            _flush_episode(ep, wall_ts)
            state.episodes.pop(key, None)
            state.pair_cooldown[key] = wall_ts + PAIR_COOLDOWN_SEC

    # Admin video feed: render annotated frame + broadcast detection snapshot.
    try:
        jpeg_bytes = _render_annotated_frame(frame, detections, interactions)
        det_snapshot = [
            {
                "cls": d.cls, "conf": round(d.conf, 3),
                "track_id": d.track_id,
                "bbox": [d.x1, d.y1, d.x2, d.y2],
            }
            for d in detections
        ]
        with state._frame_lock:
            state._annotated_jpeg = jpeg_bytes
            state._frame_detections = det_snapshot
            state._frame_ts = wall_ts

        if state.loop is not None:
            msg = {
                "ts": round(wall_ts, 3),
                "detections": len(detections),
                "persons": sum(1 for d in detections if d.cls == "person"),
                "vehicles": sum(1 for d in detections if d.cls in VEHICLE_CLASSES),
                "interactions": len(interactions),
                "objects": det_snapshot,
            }
            asyncio.run_coroutine_threadsafe(
                _broadcast_admin_detections(msg), state.loop
            )
    except Exception as exc:
        log.warning("annotated frame failed: %s", exc)


def _flush_episode(ep: Episode, wall_ts: float) -> None:
    """Materialise an episode's peak frame into an Event and hand off to the
    asyncio side for LLM enrichment + egress.

    The peak risk is downgraded by ``Episode.final_risk()`` if it lacks
    sustained support — a single high-risk frame in an otherwise calm
    episode is treated as a transient and emitted at the lower tier. This
    rejects single-frame TTC spikes from bbox jitter without losing the
    peak-frame thumbnail for review.
    """
    if ep.emitted or ep.peak_frame is None:
        return
    ep.emitted = True

    # Sustained-risk downgrade — see Episode.final_risk().
    final_risk = ep.final_risk()
    risk_demoted = final_risk != ep.peak_risk

    state.event_counter += 1
    event_id = f"evt_{int(ep.started_at * 1000)}_{state.event_counter:04d}"
    internal_name = f"{event_id}.jpg"
    public_name = public_thumbnail_name(internal_name)

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
    stream_t = ep.started_at - (state.reader.started_at if state.reader else ep.started_at)
    pair_ids = [tid for tid in (a.track_id, b.track_id) if tid is not None]
    duration_sec = round(ep.last_seen_at - ep.started_at, 2)

    scene_ctx = state.last_scene_ctx
    ego = state.last_ego_flow
    event = {
        "event_id": event_id,
        "vehicle_id": RESOLVED_VEHICLE_ID,
        "road_id": RESOLVED_ROAD_ID,
        "driver_id": RESOLVED_DRIVER_ID,
        "video_id": DEFAULT_SOURCE or "stream",
        "timestamp_sec": round(stream_t, 2),
        "wall_time": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "event_type": ep.event_type,
        "risk_level": final_risk,
        "peak_risk_level": ep.peak_risk,
        "risk_demoted": risk_demoted,
        "risk_frame_counts": dict(ep.risk_frame_counts),
        "frame_count": ep.frame_count,
        "confidence": round(min(a.conf, b.conf), 3),
        "objects": sorted({a.cls, b.cls}),
        "track_ids": pair_ids,
        "episode_duration_sec": duration_sec,
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
        ),
        "narration": None,
        # Egress-safe URL — internal unredacted copy is not served publicly.
        "thumbnail": f"thumbnails/{public_name}",
    }

    asyncio.run_coroutine_threadsafe(_emit_event(event, internal_name), state.loop)


async def _broadcast_perception(qstate: dict) -> None:
    """Broadcast a perception-state change as a control-plane SSE message.

    Uses a sentinel `_meta: "perception_state"` so the UI can render a banner
    without confusing these with safety events.
    """
    msg = {"_meta": "perception_state", **qstate}
    for q in list(state.subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


async def _broadcast_admin_detections(msg: dict) -> None:
    for q in list(state.admin_detection_subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


async def _emit_event(event: dict, internal_thumb_name: str) -> None:
    """Runs on the main asyncio loop. Narrates + enriches (parallel), then broadcasts.

    ALPR runs against the *internal* (unredacted) thumbnail because we need
    the plate text to hash it. The raw plate string is then discarded —
    only the salted hash survives into the egress payload. This is the
    key compliance boundary: plate text never reaches Slack, the SSE feed,
    or the recent-events buffer.
    """
    internal_path = THUMBS_DIR / internal_thumb_name
    public_path = THUMBS_DIR / Path(event["thumbnail"]).name

    # Three skip paths for the vision call:
    #   (a) policy: ALPR disabled unless ROAD_ALPR_MODE=third_party
    #   (b) perception is degraded — low-SNR image, money wasted
    #   (c) low-risk events — weekly-batch review SLA, ALPR adds little value
    # This prevents unnecessary external calls before rate limiting even starts.
    policy_skip = ALPR_MODE != "third_party"
    perception_skip = state.quality.risk_adjustment().get("skip_vision_enrichment", False)
    low_risk_skip = event.get("risk_level") == "low"
    skip_enrich = policy_skip or perception_skip or low_risk_skip
    event["perception_state"] = state.quality.state().get("state", "nominal")
    if skip_enrich:
        if policy_skip:
            event["enrichment_skipped"] = "alpr_policy_disabled"
        elif perception_skip:
            event["enrichment_skipped"] = "perception_degraded"
        else:
            event["enrichment_skipped"] = "low_risk_event"

    narrate_task = narrate_event(event)
    enrich_task = (
        enrich_event(event, internal_path) if not skip_enrich else _none_coro()
    )
    narration, enrichment = await asyncio.gather(narrate_task, enrich_task)
    if narration:
        event["narration"] = narration
    if enrichment:
        # Defence in depth: enrich_event() already hashes plate at the LLM
        # boundary so raw plate_text never reaches this process. Re-pop here
        # in case a caller ever wires up a different enrichment source — the
        # invariant "no raw plate in the event buffer" is enforced twice.
        enrichment.pop("plate_text", None)
        enrichment.pop("plate_state", None)
        event["enrichment"] = enrichment

    state.recent_events.append(event)
    if len(state.recent_events) > MAX_RECENT_EVENTS:
        state.recent_events.pop(0)

    # Road registry — track per-vehicle event counts + safety score.
    road_registry.record_event(event)

    for q in list(state.subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass

    # Slack gets the redacted (public) thumbnail — never the internal one.
    asyncio.create_task(slack_notify(event, public_path))

    # Active-learning sampler: if confidence is near the decision boundary,
    # tag this event for later human labelling. No-op otherwise.
    try:
        state.active_learner.maybe_sample(event)
    except Exception as exc:
        log.warning("active-learning sample failed: %s", exc)

    # Edge -> Cloud publisher: enqueues to a local JSONL, drained by a
    # background task. No-op if ROAD_CLOUD_ENDPOINT / ROAD_CLOUD_HMAC_SECRET
    # aren't set. Only redacted thumbs + hashed plate cross the wire.
    if state.edge_publisher.enabled():
        try:
            await state.edge_publisher.enqueue(event, public_path)
        except Exception as exc:
            log.warning("edge enqueue failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.loop = asyncio.get_running_loop()
    if _MISSING_IDENTITY:
        log.warning(
            "fleet identity unset for %s — using hostname fallbacks "
            "(vehicle_id=%s, road_id=%s, driver_id=%s); events will not "
            "attribute to a real fleet until these env vars are set",
            ", ".join(_MISSING_IDENTITY),
            RESOLVED_VEHICLE_ID,
            RESOLVED_ROAD_ID,
            RESOLVED_DRIVER_ID,
        )
    log.info("loading YOLO model")
    state.model = load_model()

    # Point drift monitor at the live in-memory buffer so it reads fresh
    # events rather than the on-disk snapshot.
    state.drift.set_event_source(lambda: list(state.recent_events))

    log.info("resolving source: %s", DEFAULT_SOURCE)
    try:
        hls = resolve_hls(DEFAULT_SOURCE)
        state.source_label = DEFAULT_SOURCE
        log.info("HLS resolved (%d chars)", len(hls))
    except Exception as exc:
        log.error("stream resolution failed: %s", exc)
        hls = None

    if hls:
        state.reader = StreamReader(hls, target_fps=TARGET_FPS, original_source=DEFAULT_SOURCE)
        state.reader.start(_on_frame)
        log.info("stream reader started")
    else:
        log.warning("running without live stream (resolution failed)")

    # Digest schedulers (medium hourly, low daily). Idempotent.
    start_digest_schedulers(state.loop)
    log.info("digest schedulers started")

    # Edge -> Cloud publisher loop (no-op if not configured).
    edge_task = None
    if state.edge_publisher.enabled():
        edge_task = asyncio.create_task(state.edge_publisher.run_forever())
        log.info("edge publisher started")
    else:
        log.info("edge publisher disabled (ROAD_CLOUD_ENDPOINT / _HMAC_SECRET unset)")

    # Data retention background sweep.
    retention_task = asyncio.create_task(retention_loop())
    log.info("retention policy loop started")
    score_decay_task = None
    if SCORE_DECAY_INTERVAL_SEC > 0:
        score_decay_task = asyncio.create_task(
            _score_decay_loop(SCORE_DECAY_INTERVAL_SEC)
        )
        log.info("score decay loop started (interval=%ds)", SCORE_DECAY_INTERVAL_SEC)

    # Agent executor — wired after event_lookup is available.
    state.agent_executor = AgentExecutor(
        event_lookup=_find_event,
        events_source=lambda: list(state.recent_events),
        drift_monitor=state.drift,
    )
    log.info("agent executor ready (coaching, investigation, report)")

    # Auto-run test suite in background on startup.
    start_test_run()
    log.info("test suite started in background")

    # AI Watchdog — background health monitor.
    watchdog_task = None
    if WATCHDOG_ENABLED:
        def _collect_snapshot() -> dict:
            q = state.quality.state()
            ctx = state.last_scene_ctx
            ego = state.last_ego_flow
            reader = state.reader
            drift_report = state.drift.compute().as_dict()
            llm_stats = llm_observer.stats(window_sec=300)
            recent_events = list(state.recent_events)[-25:]
            unknown_event_types = sum(
                1 for evt in recent_events
                if not evt.get("event_type") or evt.get("event_type") == "unknown"
            )
            unknown_risk_levels = sum(
                1 for evt in recent_events
                if not evt.get("risk_level") or evt.get("risk_level") == "unknown"
            )
            recent_confidences = [
                float(evt.get("confidence"))
                for evt in recent_events
                if isinstance(evt.get("confidence"), (int, float))
            ]
            return {
                "server": {
                    "running": reader is not None and reader._thread is not None and reader._thread.is_alive() if reader else False,
                    "uptime_sec": round(reader.uptime_sec(), 1) if reader else 0.0,
                    "source": state.source_label,
                    "target_fps": TARGET_FPS,
                },
                "pipeline": {
                    "frames_read": reader.frames_read if reader else 0,
                    "frames_processed": reader.frames_processed if reader else 0,
                    "reconnects": reader.reconnects if reader else 0,
                    "event_count": len(state.recent_events),
                    "active_episodes": len(state.episodes),
                },
                "perception": {
                    "state": q["state"],
                    "reason": q["reason"],
                    "samples": q["samples"],
                    "avg_confidence": q.get("avg_confidence", 0),
                    "luminance": q.get("luminance", 0),
                    "sharpness": q.get("sharpness", 0),
                },
                "drift": drift_report,
                "llm": llm_stats,
                "scene": {
                    "label": ctx.label if ctx else "unknown",
                    "reason": ctx.reason if ctx else "not yet observed",
                },
                "ego": {
                    "speed_proxy_mps": round(ego.speed_proxy_mps, 2) if ego else None,
                },
                "taxonomy": {
                    "recent_events": len(recent_events),
                    "unknown_event_types": unknown_event_types,
                    "unknown_risk_levels": unknown_risk_levels,
                    "unknown_event_ratio": round(unknown_event_types / len(recent_events), 4) if recent_events else 0.0,
                    "unknown_risk_ratio": round(unknown_risk_levels / len(recent_events), 4) if recent_events else 0.0,
                    "avg_event_confidence": round(sum(recent_confidences) / len(recent_confidences), 4) if recent_confidences else 0.0,
                },
            }

        state.watchdog = Watchdog(
            collect_fn=_collect_snapshot,
            interval_sec=WATCHDOG_INTERVAL_SEC,
        )
        watchdog_task = asyncio.create_task(state.watchdog.run_loop())
        log.info("watchdog started (interval=%ds)", WATCHDOG_INTERVAL_SEC)
    else:
        state.watchdog = None
        log.info("watchdog disabled (ROAD_WATCHDOG_ENABLED=0)")

    yield

    if state.reader:
        state.reader.stop()
    if edge_task is not None:
        edge_task.cancel()
    retention_task.cancel()
    if score_decay_task is not None:
        score_decay_task.cancel()
    if watchdog_task is not None:
        watchdog_task.cancel()


app = FastAPI(title="Live Safety Review", lifespan=lifespan)

THUMBS_DIR.mkdir(parents=True, exist_ok=True)

_REACT_BUILD = (STATIC_DIR / "assets").exists()
if _REACT_BUILD:
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
else:
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

def _find_event(event_id: str) -> dict | None:
    for ev in reversed(state.recent_events):
        if ev.get("event_id") == event_id:
            return ev
    return None


async def _on_feedback(record: dict, matched: dict | None) -> None:
    """Runs after each /api/feedback POST.

    - If verdict=fp: pull the event into the active-learning pool
      (disputed events are the highest-value training data).
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
    # Piggyback on slack_notify's webhook — use the digest post path so it
    # renders as a section, not a full block-kit high-risk card.
    try:
        from road_safety.integrations.slack import _post_digest
        await _post_digest(
            title="Drift warning",
            summary=f"Precision {report.precision:.2f} over {report.window_size} labels",
            body=warning,
        )
    except Exception as exc:
        log.warning("drift slack warn failed: %s", exc)


# Feedback (thumbs-up/down) + coaching queue routes, wired to drift + AL hooks.
mount_feedback_routes(app, on_feedback=_on_feedback, event_lookup=_find_event)


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
def favicon():
    path = STATIC_DIR / "favicon.ico"
    if path.exists():
        return FileResponse(path)
    raise HTTPException(404)


@app.get("/thumbnails/{name}")
def thumbnail(name: str, request: Request):
    """Serve redacted (public) thumbnails freely; gate unredacted on DSAR token.

    Public UI + Slack relay + SSE all reference `*_public.jpg`. Requesting the
    internal unredacted `evt_xxxx.jpg` requires a preconfigured X-DSAR-Token
    header — the minimum viable DSAR access workflow. With no token set in
    env, unredacted retrieval is closed entirely.
    """
    if "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(400, "invalid name")
    path = THUMBS_DIR / name
    if not path.exists():
        raise HTTPException(404, "thumbnail not found")
    ip = request.client.host if request.client else None
    if "_public." in name:
        if not _valid_thumb_request(name, request):
            audit.log("access_public_thumbnail", name, outcome="denied", ip=ip)
            raise HTTPException(
                403,
                "public thumbnail requires valid exp/token query params",
            )
        audit.log("access_public_thumbnail", name, outcome="success", ip=ip)
        return FileResponse(path)
    token = request.headers.get("X-DSAR-Token")
    if not DSAR_TOKEN or token != DSAR_TOKEN:
        audit.log("access_unredacted_thumbnail", name, outcome="denied", ip=ip)
        raise HTTPException(
            403,
            "unredacted thumbnail — present X-DSAR-Token header "
            "(set ROAD_DSAR_TOKEN env var on the server)",
        )
    audit.log("access_unredacted_thumbnail", name, outcome="success", ip=ip)
    return FileResponse(path)


@app.get("/stream/events")
async def stream_events(request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    state.subscribers.add(queue)

    async def gen():
        try:
            for ev in state.recent_events[-SSE_REPLAY_COUNT:]:
                yield f"data: {json.dumps(ev)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            state.subscribers.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat")
async def chat(body: dict):
    query = (body.get("query") or "").strip()
    if not query:
        raise HTTPException(400, "missing 'query'")
    audit.log("chat_query", query[:200])
    answer = await llm_chat(query, state.recent_events)
    return {"answer": answer}


@app.get("/api/live/status")
def live_status():
    q = state.quality.state()
    return {
        "source": state.source_label,
        "location": LOCATION,
        "running": state.reader is not None and state.reader._thread is not None and state.reader._thread.is_alive(),
        "event_count": len(state.recent_events),
        "frames_read": state.reader.frames_read if state.reader else 0,
        "frames_processed": state.reader.frames_processed if state.reader else 0,
        "reconnects": state.reader.reconnects if state.reader else 0,
        "uptime_sec": round(state.reader.uptime_sec(), 1) if state.reader else 0.0,
        "started_at": state.reader.started_at if state.reader else None,
        "llm_configured": llm_configured(),
        "slack_configured": slack_configured(),
        "target_fps": TARGET_FPS,
        "active_episodes": len(state.episodes),
        "tracker": "bytetrack",
        "risk_model": "ttc+ground_plane",
        "pii_redaction": "face+plate",
        "dsar_endpoint_enabled": bool(DSAR_TOKEN),
        "public_thumb_token_required": PUBLIC_THUMBS_REQUIRE_TOKEN,
        "alpr_mode": ALPR_MODE,
        "perception": {
            "state": q["state"],
            "reason": q["reason"],
            "samples": q["samples"],
            "since_sec": q["since_sec"],
            "avg_confidence": q["avg_confidence"],
            "luminance": q["luminance"],
            "sharpness": q["sharpness"],
        },
    }


@app.get("/api/live/perception")
def live_perception():
    return state.quality.state()


@app.get("/api/live/scene")
def live_scene():
    """Current scene context (urban/highway/parking/unknown) + adaptive
    thresholds in effect right now. Useful for the UI to explain why a given
    TTC threshold is being applied."""
    ctx = state.last_scene_ctx
    if ctx is None:
        return {"label": "unknown", "reason": "not yet observed"}
    thr = state.scene.adaptive_thresholds(ctx)
    ego = state.last_ego_flow
    return {
        "label": ctx.label,
        "confidence": round(ctx.confidence, 2),
        "speed_proxy_mps": (
            round(ctx.speed_proxy_mps, 2) if ctx.speed_proxy_mps is not None else None
        ),
        "pedestrian_rate_per_min": round(ctx.pedestrian_rate_per_min, 2),
        "vehicle_rate_per_min": round(ctx.vehicle_rate_per_min, 2),
        "reason": ctx.reason,
        "thresholds": {
            "ttc_high_sec": thr.ttc_high_sec,
            "ttc_med_sec": thr.ttc_med_sec,
            "dist_high_m": thr.dist_high_m,
            "dist_med_m": thr.dist_med_m,
        },
        "ego_flow": (
            {
                "speed_proxy_mps": round(ego.speed_proxy_mps, 2),
                "confidence": round(ego.confidence, 2),
            }
            if ego is not None else None
        ),
    }


@app.get("/api/drift")
def api_drift():
    """Rolling precision over the most recent labelled events. Emits a
    structured report broken down by risk level and event_type."""
    return state.drift.compute().as_dict()


@app.post("/api/active_learning/export")
def api_active_learning_export(request: Request):
    """Bundle pending active-learning samples into a zip for Label Studio /
    CVAT import. Returns the zip path (on-disk; operator downloads it
    out-of-band) or 204 when the pool is empty."""
    _require_admin(request, "active-learning export")
    audit.log("export_active_learning", "batch_export")
    try:
        path = state.active_learner.export_batch()
    except Exception as exc:
        raise HTTPException(500, f"export failed: {exc}")
    if path is None:
        raise HTTPException(204, "no pending samples")
    return {"path": str(path)}


@app.get("/api/live/events")
def live_events(risk_level: str | None = None, event_type: str | None = None, limit: int = 100):
    items = list(state.recent_events)
    if risk_level:
        items = [e for e in items if e["risk_level"] == risk_level]
    if event_type:
        items = [e for e in items if e["event_type"] == event_type]
    return items[-limit:]


def _load_batch(name: str):
    path = DATA_DIR / name
    if not path.exists():
        raise HTTPException(404, f"{name} not found — run analyze.py first")
    return json.loads(path.read_text())


@app.get("/api/events")
def events(
    risk_level: str | None = None,
    event_type: str | None = None,
    limit: int = 500,
):
    """Live events from the in-memory recent-events buffer.

    Previously this endpoint read a stale on-disk `events.json` written only
    by the batch `analyze.py` pipeline, so dashboards saw 0 events even while
    the live stream emitted them. Now it serves the same buffer as
    `/api/live/events` and `/api/summary`.
    """
    items = list(state.recent_events)
    if risk_level:
        items = [e for e in items if e.get("risk_level") == risk_level]
    if event_type:
        items = [e for e in items if e.get("event_type") == event_type]
    return items[-limit:]


@app.get("/api/events/{event_id}")
def event(event_id: str):
    for ev in state.recent_events:
        if ev.get("event_id") == event_id:
            return ev
    raise HTTPException(404, "event not found")


# ---------------------------------------------------------------------------
# LLM observability endpoints
# ---------------------------------------------------------------------------

@app.get("/api/llm/stats")
def llm_stats(request: Request, window_sec: float | None = None):
    """Aggregated LLM usage: cost, latency percentiles, error/skip rates."""
    _require_admin(request, "LLM observability")
    return llm_observer.stats(window_sec)


@app.get("/api/llm/recent")
def llm_recent(request: Request, limit: int = 50):
    """Raw recent LLM call records for debugging."""
    _require_admin(request, "LLM observability")
    return {"items": llm_observer.recent(min(limit, 200))}


# ---------------------------------------------------------------------------
# Audit endpoints
# ---------------------------------------------------------------------------

@app.get("/api/audit")
def api_audit(request: Request, limit: int = 100):
    """Tail of the audit log for compliance review."""
    _require_admin(request, "audit log")
    return {"items": audit.tail(min(limit, 500))}


@app.get("/api/audit/stats")
def api_audit_stats(request: Request):
    _require_admin(request, "audit log")
    return audit.stats()


# ---------------------------------------------------------------------------
# Data retention endpoints
# ---------------------------------------------------------------------------

@app.post("/api/retention/sweep")
def api_retention_sweep(request: Request):
    """Trigger an immediate retention sweep (normally runs hourly)."""
    _require_admin(request, "retention control")
    audit.log("retention_sweep", "manual_trigger")
    return retention_sweep()


# ---------------------------------------------------------------------------
# Road / multi-vehicle endpoints
# ---------------------------------------------------------------------------

@app.get("/api/road/summary")
def api_road_summary(request: Request):
    """System-wide aggregation: all vehicles, scores, event counts."""
    _require_admin(request, "road summary")
    return road_registry.road_summary()


@app.get("/api/road/vehicle/{vehicle_id}")
def api_road_vehicle(request: Request, vehicle_id: str):
    _require_admin(request, "road vehicle detail")
    v = road_registry.get_vehicle(vehicle_id)
    if v is None:
        raise HTTPException(404, "vehicle not found")
    return v


@app.get("/api/road/drivers")
def api_road_drivers(request: Request, limit: int = 20):
    """Driver safety leaderboard (worst-first)."""
    _require_admin(request, "driver leaderboard")
    return {"drivers": road_registry.driver_leaderboard(min(limit, 100))}


# ---------------------------------------------------------------------------
# AI Agent endpoints
# ---------------------------------------------------------------------------

@app.post("/api/agents/coaching")
async def api_agent_coaching(request: Request, body: dict):
    """Generate an AI coaching note for a specific event."""
    _require_admin(request, "agent coaching")
    event_id = (body.get("event_id") or "").strip()
    if not event_id:
        raise HTTPException(400, "missing 'event_id'")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_coaching", event_id)
    result = await run_coaching_agent(state.agent_executor, event_id)
    return result.as_dict()


@app.post("/api/agents/investigation")
async def api_agent_investigation(request: Request, body: dict):
    """Run an AI investigation on a specific event."""
    _require_admin(request, "agent investigation")
    event_id = (body.get("event_id") or "").strip()
    if not event_id:
        raise HTTPException(400, "missing 'event_id'")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_investigation", event_id)
    result = await run_investigation_agent(state.agent_executor, event_id)
    return result.as_dict()


@app.post("/api/agents/report")
async def api_agent_report(request: Request):
    """Generate an AI safety summary report."""
    _require_admin(request, "agent report")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_report", "session_report")
    result = await run_report_agent(state.agent_executor)
    return result.as_dict()


# ---------------------------------------------------------------------------
# Admin: live video + detection dashboard
# ---------------------------------------------------------------------------

@app.get("/api/admin/health")
def admin_health():
    """Comprehensive health snapshot for the admin dashboard."""
    q = state.quality.state()
    ctx = state.last_scene_ctx
    ego = state.last_ego_flow
    reader = state.reader
    return {
        "server": {
            "running": reader is not None and reader._thread is not None and reader._thread.is_alive(),
            "uptime_sec": round(reader.uptime_sec(), 1) if reader else 0.0,
            "started_at": reader.started_at if reader else None,
            "source": state.source_label,
            "location": LOCATION,
            "target_fps": TARGET_FPS,
        },
        "pipeline": {
            "frames_read": reader.frames_read if reader else 0,
            "frames_processed": reader.frames_processed if reader else 0,
            "reconnects": reader.reconnects if reader else 0,
            "event_count": len(state.recent_events),
            "active_episodes": len(state.episodes),
            "tracker": "bytetrack",
            "risk_model": "ttc+ground_plane",
            "model": Path(MODEL_PATH).name,
        },
        "integrations": {
            "llm_configured": llm_configured(),
            "slack_configured": slack_configured(),
            "edge_publisher": state.edge_publisher.enabled(),
            "pii_redaction": "face+plate",
            "dsar_endpoint": bool(DSAR_TOKEN),
            "public_thumb_token_required": PUBLIC_THUMBS_REQUIRE_TOKEN,
            "alpr_mode": ALPR_MODE,
        },
        "perception": {
            "state": q["state"],
            "reason": q["reason"],
            "samples": q["samples"],
            "avg_confidence": q["avg_confidence"],
            "luminance": q["luminance"],
            "sharpness": q["sharpness"],
        },
        "scene": {
            "label": ctx.label if ctx else "unknown",
            "confidence": round(ctx.confidence, 2) if ctx else None,
            "speed_proxy_mps": round(ctx.speed_proxy_mps, 2) if ctx and ctx.speed_proxy_mps is not None else None,
            "reason": ctx.reason if ctx else "not yet observed",
        },
        "ego": {
            "speed_proxy_mps": round(ego.speed_proxy_mps, 2) if ego else None,
            "confidence": round(ego.confidence, 2) if ego else None,
        },
    }


@app.get("/api/watchdog")
def watchdog_summary():
    """Watchdog status and finding counts."""
    if state.watchdog is None:
        return {"enabled": False}
    return state.watchdog.status()


@app.get("/api/watchdog/recent")
def watchdog_recent(n: int = 50):
    """Most recent watchdog findings for investigation."""
    return watchdog_tail(min(n, 200))


@app.delete("/api/watchdog/findings")
def watchdog_delete_findings(clear_all: bool = False):
    """Delete specific findings by composite key or clear all."""
    if clear_all:
        removed = watchdog_delete(indices=None)
        return {"deleted": removed}
    return {"deleted": 0}


@app.post("/api/watchdog/findings/delete")
async def watchdog_delete_selected(request: Request):
    """Delete selected findings by snapshot_id + ts composite keys."""
    body = await request.json()
    keys: list[str] = body.get("keys", [])
    if not keys:
        return {"deleted": 0}
    removed = watchdog_delete_by_id(keys)
    return {"deleted": removed}


@app.get("/admin")
def admin_page():
    if _REACT_BUILD:
        return FileResponse(STATIC_DIR / "index.html")
    return FileResponse(STATIC_DIR / "admin.html")

@app.get("/dashboard")
def dashboard_page():
    if _REACT_BUILD:
        return FileResponse(STATIC_DIR / "index.html")
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/monitoring")
def monitoring_page():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/admin/video_feed")
def admin_video_feed():
    """MJPEG stream of annotated frames (bounding boxes + interaction lines)."""
    def generate():
        while True:
            with state._frame_lock:
                jpeg = state._annotated_jpeg
            if jpeg is not None:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                )
            time.sleep(0.4)

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/admin/detections")
async def admin_detections_sse(request: Request):
    """SSE stream of per-frame detection snapshots for the admin dashboard."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    state.admin_detection_subscribers.add(queue)

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=10.0)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            state.admin_detection_subscribers.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Test runner endpoints
# ---------------------------------------------------------------------------

@app.get("/api/tests/status")
def api_test_status():
    """Current test run status and results."""
    return test_run_state.as_dict()


@app.post("/api/tests/run")
def api_test_run():
    """Trigger a new test run (if not already running)."""
    if test_run_state.status == "running":
        return {"ok": False, "reason": "already running"}
    start_test_run()
    return {"ok": True}


@app.get("/api/summary")
def summary():
    return _load_batch("summary.json")
