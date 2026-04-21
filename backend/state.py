"""In-memory state for the live safety pipeline.

Holds the three domain classes and the process-wide singleton that
``server.py``, the perception thread, and every route handler share:

    * :class:`Episode`          — temporal de-duplication across frames.
    * :class:`StreamSlot`       — per-source perception state.
    * :class:`LiveStateSnapshot`— frozen view used by route handlers.
    * :class:`LiveState`        — process-wide state container.
    * ``state``                 — module-level singleton instance.

Camera-site identity (``RESOLVED_VEHICLE_ID`` / ``RESOLVED_ROAD_ID`` /
``RESOLVED_DRIVER_ID``) is resolved at import time so every emitted event
can attribute to a real camera site even when env vars are unset.

This module was extracted from ``server.py`` (step 1 of the refactor
plan). Nothing here changed behaviourally; only the location.

UI connection
-------------
Page: none directly.
UI element: No direct UI — shared in-memory state container. The most recent values it holds are what get returned to /api/live/status (top-bar uptime widget on every page).
"""

import asyncio
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from backend.config import (
    DEFAULT_STREAM_SOURCE as DEFAULT_SOURCE,
    DRIVER_ID,
    ROAD_ID,
    VEHICLE_ID,
    camera_calibration_for,
)
from backend.core.context import SceneContextClassifier
from backend.core.detection import TrackHistory
from backend.core.egomotion import EgoMotionEstimator
from backend.core.quality import QualityMonitor
from backend.core.stream import StreamReader, classify_source
from backend.integrations.edge_publisher import EdgePublisher
from backend.services.agents import AgentExecutor
from backend.services.drift import ActiveLearningSampler, DriftMonitor

if TYPE_CHECKING:
    from backend.core.validator import ValidatorWorker
    from backend.services.impact import ImpactMonitor
    from backend.services.ops_sampler import OpsSampler
    from backend.services.watchdog import Watchdog


# ===== SECTION: CAMERA-SITE IDENTITY RESOLUTION =====
# Events are meaningless to downstream analytics if they can't be attributed
# to a specific camera site / road / sensor. We resolve identity ONCE at
# import time; the results are frozen into module-level constants below and
# stamped onto every emitted event in ``_flush_episode``. In road-cam
# deployments the ``vehicle_id`` / ``driver_id`` fields are reused as
# camera-site / sensor attribution slots — their values are whatever the
# operator configures via env vars.


def _resolve_identity() -> tuple[str, str, str, list[str]]:
    """Return the effective camera-site identity for this process, plus any gaps.

    Reads ``VEHICLE_ID`` / ``ROAD_ID`` / ``DRIVER_ID`` (sourced from env in
    ``backend/config.py``). These identifiers are attribution slots —
    in a road-cam deployment their values are typically the camera-site
    vehicle / road / sensor IDs. If any is missing, substitutes a stable
    hostname-derived placeholder so events still emit — but also records
    the missing env-var names so ``lifespan`` can log a loud warning.

    Returns:
        A 4-tuple ``(vehicle_id, road_id, driver_id, missing_env_vars)``.
        ``missing_env_vars`` is the list of env var names that were empty
        (e.g. ``["ROAD_VEHICLE_ID"]``) — empty means fully configured.
    """
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
# Note: tuple-unpacking a function result into multiple module-level
# constants is a common Python idiom. These values are frozen for the
# lifetime of the process; swapping identity mid-run would desync
# downstream cloud aggregation.


# ===== SECTION: TUNABLE CONSTANTS (WHY each matters) =====

# Sustained-risk requirements for episode emission. A single high-risk frame
# in an otherwise calm episode is almost always a transient detection artefact;
# real conflicts produce ≥ 2 high-risk frames over ≥ 1 s of episode duration.
# WHY these numbers: lowering ``MIN_HIGH_RISK_FRAMES`` below 2 lets bbox-
# jitter spikes through as "high"; raising ``MIN_HIGH_RISK_EPISODE_SEC``
# above ~1s starts missing real short-lived collisions (motorbike cut-ins).
MIN_HIGH_RISK_FRAMES = 2
MIN_MEDIUM_RISK_FRAMES = 2
MIN_HIGH_RISK_EPISODE_SEC = 1.0


# ===== SECTION: EPISODE — TEMPORAL DE-DUPLICATION =====
# An "episode" aggregates many consecutive frames observing the SAME pair of
# tracked objects into ONE emitted event. Without this layer the SSE feed
# would spew a hundred high-risk alerts for a single near-miss.


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
        """Initialise an empty episode for a specific (event_type, track-pair).

        Args:
            event_type: One of ``"pedestrian_proximity"`` /
                ``"vehicle_close_interaction"`` / etc. (see
                ``core/detection.py::find_interactions``).
            pair: Canonical ``(lo, hi)`` track-id pair as produced by
                ``_pair_key`` below.
            started_at: Wall-clock seconds (``time.time()``) when the pair
                was first observed. Doubles as the reference for the
                ``timestamp_sec`` field stamped onto the emitted event.

        State held:
            * ``peak_*``: snapshot of the worst frame seen so far (frame
              pixels, detections list, primary + secondary detection,
              distance_px, TTC, distance_m, risk label).
            * ``frame_count`` / ``risk_frame_counts``: per-risk tallies
              used by ``final_risk`` for the sustained-risk downgrade.
            * ``emitted``: one-shot guard — each episode emits at most
              one event regardless of how many flush attempts happen.
        """
        self.event_type = event_type
        self.pair = pair
        self.started_at = started_at
        self.last_seen_at = started_at
        # Orientation-policy decision cached on the episode so `_flush_episode`
        # can stamp SAE J3063 family + display-type overrides onto the emitted
        # event payload without re-running the gate at flush time. Populated
        # by the first frame that opens the episode (see the perception
        # pipeline); later
        # frames never overwrite it because a pair that started as BSW cannot
        # mid-episode become FCW without a new pair key.
        self.camera_orientation: str | None = None
        self.event_taxonomy: str = "FCW"
        self.display_event_type: str | None = None
        self.policy_reason: str | None = None
        self.peak_frame = None
        self.peak_detections: list = []
        self.peak_primary = None
        self.peak_secondary = None
        # ``float("inf")`` is a valid float that compares greater than any
        # finite number — used as an initial sentinel so the first real
        # measurement always wins the "tightest distance" check below.
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
        """Fold one fresh frame observation into the rolling episode.

        Replaces the stored "peak" snapshot when the new frame is strictly
        worse than anything seen before — either a higher risk tier, or
        the same tier at a tighter pixel distance (tighter = more
        visually compelling thumbnail for review).

        Args:
            frame: Raw BGR numpy image from OpenCV. ``frame.copy()`` is
                held when it becomes the peak — we own an independent
                copy, the background reader is free to reuse its buffer.
            detections: List of ``Detection`` dataclasses for the whole
                frame (not just the interacting pair). The full list is
                stored so the redactor can draw bounding boxes around
                every visible object, not just the conflict participants.
            a, b: The two ``Detection`` objects that form this interaction.
            distance_px: 2D pixel distance between bbox centres — used as
                a last-resort distance proxy and as the peak tiebreaker.
            ttc: Time-to-collision in seconds, or ``None`` when unknown.
            dist_m: Estimated 3D separation in metres, or ``None``.
            risk: ``"low"`` / ``"medium"`` / ``"high"`` — already scene-
                adapted and low-speed-floored by the caller.
            now: Wall-clock timestamp for this observation.
        """
        self.last_seen_at = now
        self.frame_count += 1
        if risk in self.risk_frame_counts:
            self.risk_frame_counts[risk] += 1
        # ``risk_rank`` gives us an ordinal comparison on the string enum.
        # Keeping the mapping local to this method means we can't
        # accidentally mutate it from outside.
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

        Returns:
            ``"low"`` / ``"medium"`` / ``"high"``. The returned value may
            differ from ``self.peak_risk`` — ``_flush_episode`` records
            ``risk_demoted=True`` when this happens so reviewers can tell
            at a glance that the peak wasn't sustained.
        """
        # ``max(..., 0.0)`` guards against clock skew / reorderings that
        # could produce a negative duration and misleadingly pass the
        # threshold in either direction.
        duration = max(self.last_seen_at - self.started_at, 0.0)
        high = self.risk_frame_counts.get("high", 0)
        med = self.risk_frame_counts.get("medium", 0)

        if self.peak_risk == "high":
            if high >= MIN_HIGH_RISK_FRAMES and duration >= MIN_HIGH_RISK_EPISODE_SEC:
                return "high"
            # Demote to medium if the medium support is there, else low.
            # Rationale: a momentary TTC spike with no follow-through is
            # likely bbox jitter, not an actual near-miss.
            if (high + med) >= MIN_MEDIUM_RISK_FRAMES:
                return "medium"
            return "low"
        if self.peak_risk == "medium":
            if (high + med) >= MIN_MEDIUM_RISK_FRAMES:
                return "medium"
            return "low"
        return "low"


# ===== SECTION: LIVESTATE — SINGLETON HOLDING ALL IN-MEMORY STATE =====
# One instance of ``LiveState`` exists per process (``state = LiveState()``
# below). It glues together the YOLO model, stream reader, episode registry,
# SSE subscribers, perception / scene / drift monitors, and the latest
# annotated frame for the admin video feed. Threads coordinate through it,
# so read/write guards (``threading.Lock``) protect any non-atomic fields.


class StreamSlot:
    """Per-source perception state.

    Each monitored stream gets its own slot bundling: the StreamReader,
    the per-frame annotated JPEG buffer, and every per-source perception
    object (quality, scene, ego, track history, episodes, pair cooldown).
    Detected events from this slot land in the SHARED ``state.recent_events``
    buffer with ``source_id`` / ``source_name`` tags so downstream
    consumers (UI, Slack, cloud) can disambiguate.

    Why per-slot for quality/scene/ego/episodes/pair_cooldown:
        These are stateful estimators whose output depends on a rolling
        window of frames from ONE camera. Sharing them across cameras
        would corrupt every estimate.

    Why shared for recent_events / subscribers / drift / publisher:
        These are pure aggregators / fan-outs — no per-source state to
        maintain. SSE clients want one merged stream, the cloud wants
        one HMAC-signed batch, drift is deployment-wide.
    """

    def __init__(self, source_id: str, name: str, original_source: str):
        self.source_id = source_id
        self.name = name
        # Per-camera calibration: focal length (px), mount height (m),
        # horizon fraction, orientation (forward/rear/side), and the
        # camera-to-body-edge offset along the optical axis. Resolved once
        # at slot construction from per-slot defaults + per-slot env
        # overrides (``ROAD_CAMERA_<FIELD>__<SLOT_ID>``). Frozen for the
        # lifetime of the slot so threads can read it without locks.
        # Threading the same calibration through every distance/TTC call
        # in this slot's perception loop is what makes a multi-camera
        # install (front 1× + rear 0.5× + left 0.5×) report accurate
        # distances per camera instead of pretending all three share the
        # front cam's intrinsics.
        self.calibration = camera_calibration_for(source_id)
        # Pre-resolution operator-supplied URL. The resolved URL (post
        # yt-dlp) is stashed on ``reader.source_url`` once started.
        self.original_source = original_source
        # UI-facing mode tag: "dashcam_file" (looping local MP4 source —
        # typically used for testing), "live_yt", "live_hls", "webcam",
        # "unknown". Drives the badge on the admin grid tile and whether
        # the reader loops on EOF.
        self.stream_type = classify_source(original_source)
        # ``None`` until the slot has been started at least once.
        self.reader: StreamReader | None = None
        # Most recent reason a start attempt failed (e.g. yt-dlp resolution
        # failure). Cleared on successful start. Surfaced over the API so
        # operators see *why* a stream is offline.
        self.last_error: str | None = None
        # Operator-controlled detection toggle. When False, ``_on_frame``
        # still renders the raw frame to the slot's MJPEG buffer (so the
        # operator can keep watching the camera) but skips YOLO,
        # quality / scene / ego updates, and event emission entirely. The
        # CPU saving is large; the trade-off is no boxes / no alerts from
        # this slot until re-enabled.
        self.detection_enabled: bool = True
        # Per-source perception estimators — fresh state machine per camera.
        self.track_history = TrackHistory()
        self.episodes: dict[tuple[int, int], Episode] = {}
        self.pair_cooldown: dict[tuple[int, int], float] = {}
        self.quality = QualityMonitor()
        self.last_perception_state: str | None = None
        # Thread the slot's camera calibration through the ego-motion estimator
        # so the pinhole speed-proxy uses the *correct* focal length + mount
        # height per slot (forward-facing 600px / 1.25m, rearward 260px / 1.10m,
        # sideways 260px / 1.00m). Also lets the estimator emit a signed
        # ``direction`` label which the orientation policy consumes to gate
        # rear-facing-camera events on observed reverse-direction scene flow.
        self.ego = EgoMotionEstimator(calibration=self.calibration)
        self.scene = SceneContextClassifier()
        self.last_ego_flow = None
        self.last_scene_ctx = None
        # Per-source MJPEG buffer. The capture thread writes; HTTP handlers
        # read. A dedicated lock per slot avoids cross-source contention.
        self._frame_lock = threading.Lock()
        self._annotated_jpeg: bytes | None = None
        self._frame_detections: list[dict] = []
        self._frame_ts: float = 0.0
        # Most-recent raw frame (BGR ndarray) captured for this slot. Used by
        # the polling endpoint as a fallback when ``_annotated_jpeg`` hasn't
        # been populated yet (e.g. first poll after stream start, or first
        # frame after a viewer-cycle). Storing the reference is O(1); we copy
        # only when we actually need to encode.
        self._latest_raw_frame = None
        # Active MJPEG viewer count. Incremented by ``_mjpeg_response`` on
        # connect and decremented in its ``finally`` block on disconnect.
        # When zero, ``_on_frame`` skips ``_render_annotated_frame`` /
        # ``cv2.imencode`` — the biggest per-frame cost after YOLO itself.
        self._mjpeg_subscribers: int = 0
        # Monotonic timestamp of the most recent poll to ``/admin/frame/{id}``.
        # The admin grid uses short-lived polls instead of a persistent MJPEG
        # connection (to dodge the browser's 6-conn-per-host cap), so viewer
        # presence has to be inferred from recent polls with a TTL.
        self._last_poll_monotonic: float = 0.0
        # ----- Per-stage latency ring buffers (BE-D5.A) -----
        # Populated by ``_on_frame`` / ``_flush_episode`` on the perception
        # thread; read by ``admin_health`` on the FastAPI thread pool. The
        # dedicated ``_stage_lock`` keeps us off the hot ``_frame_lock`` so
        # the health route never contends with the MJPEG encode path.
        # Each deque is bounded (``maxlen=200``) so the measurement path
        # is O(1) and memory stays flat regardless of runtime duration.
        self.stage_timings_ms: dict[str, deque] = {
            "yolo": deque(maxlen=200),
            "ego": deque(maxlen=200),
            "scene": deque(maxlen=200),
            "quality": deque(maxlen=200),
            "emit": deque(maxlen=200),
        }
        self._stage_lock = threading.Lock()

    def record_stage_ms(self, name: str, elapsed_ms: float) -> None:
        """Record a single stage latency sample.

        Called from the perception thread (``_on_frame``) and the emission
        path (``_flush_episode``). Thread-safe via ``_stage_lock``.
        """
        buf = self.stage_timings_ms.get(name)
        if buf is None:
            return
        with self._stage_lock:
            buf.append(elapsed_ms)

    def stage_stats(self) -> dict[str, dict]:
        """Return p50 / p95 / samples per stage for ``admin_health``.

        Snapshot is taken under ``_stage_lock`` and sorted outside the
        lock so the perception thread is blocked for as short a window
        as possible.
        """
        out: dict[str, dict] = {}
        with self._stage_lock:
            snapshots = {
                name: list(samples)
                for name, samples in self.stage_timings_ms.items()
            }
        for name, samples in snapshots.items():
            if not samples:
                out[name] = {"p50_ms": None, "p95_ms": None, "samples": 0}
                continue
            sorted_s = sorted(samples)
            n = len(sorted_s)
            p50 = sorted_s[n // 2]
            p95 = sorted_s[min(n - 1, int(n * 0.95))]
            out[name] = {
                "p50_ms": round(p50, 2),
                "p95_ms": round(p95, 2),
                "samples": n,
            }
        return out

    def has_viewers(self) -> bool:
        # Int read is atomic in CPython; a one-frame stale value is harmless
        # (at worst we skip one encode the frame a viewer connects on).
        if self._mjpeg_subscribers > 0:
            return True
        # Poll-based viewer: any /admin/frame hit in the last 2s counts. The
        # grid polls at ~400ms, so 2s = 5 polls of slack before we let the
        # encode path go idle (which matters on multi-stream hosts).
        return (time.monotonic() - self._last_poll_monotonic) < 2.0

    def mark_polled(self) -> None:
        self._last_poll_monotonic = time.monotonic()

    def _acquire_viewer(self) -> None:
        with self._frame_lock:
            self._mjpeg_subscribers += 1

    def _release_viewer(self) -> None:
        with self._frame_lock:
            self._mjpeg_subscribers = max(0, self._mjpeg_subscribers - 1)
            # Intentionally do NOT reset ``_annotated_jpeg`` here. Two reasons:
            #   1. The polling endpoint (``/admin/frame/{id}``) is a separate
            #      viewer path that doesn't increment ``_mjpeg_subscribers``;
            #      dropping the cached frame here strands every poll-based
            #      tile on the dark placeholder JPEG until the next
            #      perception tick (~0.5s) produces a fresh encode. With 6
            #      streams contending for the shared YOLO model the actual
            #      encode rate is closer to 0.5fps per slot, so the gap is
            #      visibly long.
            #   2. A stale-but-recent frame is strictly better UX than the
            #      placeholder JPEG. The next encode overwrites it anyway.

    def is_running(self) -> bool:
        # A paused reader is still "alive" (its capture thread is looping on
        # the pause gate) but from the UI's perspective it is not running —
        # frames are frozen, detection is off. Returning False while paused
        # keeps the Start/Pause toggle in sync with what the operator sees.
        return (
            self.reader is not None
            and self.reader._thread is not None
            and self.reader._thread.is_alive()
            and not self.reader.is_paused()
        )

    def status_dict(self) -> dict:
        """Public snapshot for ``/api/live/sources``."""
        q = self.quality.state()
        r = self.reader
        # Playback position: populated for looped local-file sources so the
        # frontend map overlay can sync its GPS marker to the MP4 loop. For
        # live feeds both numbers are 0.0 and the frontend falls back to a
        # wallclock loop.
        pos_sec, duration_sec = (
            r.playback_position() if r is not None else (0.0, 0.0)
        )
        return {
            "id": self.source_id,
            "name": self.name,
            "url": self.original_source,
            "stream_type": self.stream_type,
            "running": self.is_running(),
            "detection_enabled": self.detection_enabled,
            "last_error": self.last_error,
            "frames_read": r.frames_read if r else 0,
            "frames_processed": r.frames_processed if r else 0,
            "uptime_sec": round(r.uptime_sec(), 1) if r else 0.0,
            "playback_pos_sec": round(pos_sec, 2),
            "playback_duration_sec": round(duration_sec, 2),
            "started_at": r.started_at if r else None,
            "active_episodes": len(self.episodes),
            "perception_state": q.get("state"),
            "perception_reason": q.get("reason"),
        }


@dataclass(frozen=True)
class LiveStateSnapshot:
    """Immutable snapshot of ``LiveState`` at a single instant.

    Produced under ``state.lock`` so every field is consistent with every
    other field. Routes consume this instead of reading the live
    ``LiveState`` object (which the perception thread mutates
    concurrently). Paired with BE-D6 — this dataclass is the same shape
    the Pydantic response model will wrap.

    Fields:
        frames_read_total: Sum of ``reader.frames_read`` across all slots
            that have an active reader. Slots without a reader contribute
            ``0``.
        frames_processed_total: Same but for ``reader.frames_processed``.
        episodes_total: Sum of ``len(slot.episodes)`` across all slots.
        recent_events_count: ``len(state.recent_events)`` at snapshot time.
        recent_events: Shallow tuple copy of the recent-events list. The
            tuple is frozen but its dict elements remain mutable — routes
            MUST NOT mutate them; treat the contents as read-only.
        primary_source_id: The ``LiveState.PRIMARY_ID`` constant carried
            through for response shape clarity.
        sources: Tuple of per-slot ``status_dict()`` snapshots — one
            element per slot in ``state.slots``. Order is insertion
            order (matches Python 3.7+ dict iteration).
    """

    frames_read_total: int
    frames_processed_total: int
    episodes_total: int
    recent_events_count: int
    recent_events: tuple[dict, ...]
    primary_source_id: str
    sources: tuple[dict, ...]


class LiveState:
    """Process-wide in-memory state for the live safety pipeline.

    Holds the loaded YOLO model, the asyncio loop, every shared aggregator
    (recent events, SSE subscribers, drift monitor, edge publisher), and a
    registry of per-source ``StreamSlot``s.

    Backwards-compatibility: legacy code paths read fields like
    ``state.reader``, ``state.quality``, ``state.scene``, ``state.episodes``
    that used to be single-source. Those are now ``@property``s that
    delegate to the *primary* slot. Any new code should use
    ``state.slots[source_id]`` explicitly.

    Lifecycle:
        * Constructed at module import time with an empty primary slot
          (no reader yet) so attribute access during import doesn't NPE.
        * ``lifespan`` populates ``loop``, ``model``, builds the
          configured slots, starts each reader.
        * On shutdown, ``lifespan`` cancels background tasks and stops
          every slot's reader.
    """

    PRIMARY_ID = "primary"

    def __init__(self):
        self.model: Any = None
        self.source_label: str = DEFAULT_SOURCE
        self.loop: asyncio.AbstractEventLoop | None = None
        self.recent_events: list[dict] = []
        self.subscribers: set[asyncio.Queue] = set()
        self.event_counter = 0
        self.drift = DriftMonitor()
        self.active_learner = ActiveLearningSampler()
        self.edge_publisher = EdgePublisher()
        self.agent_executor: AgentExecutor | None = None
        self.watchdog: "Watchdog | None" = None
        self.admin_detection_subscribers: set[asyncio.Queue] = set()
        self.ops_sampler: "OpsSampler | None" = None
        self.settings_impact: "ImpactMonitor | None" = None
        self.settings_impact_subscribers: list[asyncio.Queue[Any]] = []
        # Background validator (dual-model shadow detector). Populated in
        # ``lifespan`` when ``VALIDATOR_ENABLED`` is true; ``None`` in dev
        # and single-model deployments.
        self.validator: "ValidatorWorker | None" = None
        # Source registry. Always contains at least the primary slot
        # (created here so legacy ``state.X`` proxies have a target to
        # delegate to). ``lifespan`` may rename / replace it once it
        # reads the configured sources.
        self.slots: dict[str, StreamSlot] = {
            self.PRIMARY_ID: StreamSlot(self.PRIMARY_ID, "Primary", DEFAULT_SOURCE),
        }
        # BE-D8: guards routes that read perception-thread state against
        # torn reads. ``_on_frame`` / ``_flush_episode`` briefly acquire
        # this lock around updates to ``recent_events`` and the per-slot
        # fields that ``snapshot()`` reads (via ``status_dict()``); route
        # handlers consume a frozen snapshot taken under the same lock so
        # every field is consistent with every other field. Held for a
        # microsecond — no contention expected with the perception thread.
        self.lock = threading.Lock()

    def snapshot(self) -> LiveStateSnapshot:
        """Return a frozen, consistent view of this ``LiveState``.

        Acquires ``self.lock`` once, reads every field the public /
        admin routes need, and returns a frozen dataclass. Routes MUST
        call this instead of reading the live ``state.*`` attributes —
        the perception thread can be mid-update to any of them.

        The per-slot ``status_dict()`` calls happen inside the lock so
        frame counts, uptime, and perception state stay mutually
        consistent. Expensive work is intentionally kept OUT of the
        locked region (routes do their own formatting afterwards).
        """
        with self.lock:
            frames_r = 0
            frames_p = 0
            episodes = 0
            sources: list[dict] = []
            for _sid, slot in self.slots.items():
                reader = slot.reader
                if reader is not None:
                    frames_r += int(getattr(reader, "frames_read", 0) or 0)
                    frames_p += int(getattr(reader, "frames_processed", 0) or 0)
                episodes += len(slot.episodes)
                sources.append(slot.status_dict())
            return LiveStateSnapshot(
                frames_read_total=frames_r,
                frames_processed_total=frames_p,
                episodes_total=episodes,
                recent_events_count=len(self.recent_events),
                # Shallow copy: the tuple is frozen but its dict refs are
                # the same objects in the live buffer. Routes must treat
                # the dicts as read-only; mutating them races with the
                # perception thread.
                recent_events=tuple(self.recent_events),
                primary_source_id=self.PRIMARY_ID,
                sources=tuple(sources),
            )

    def recent_events_snapshot(self, limit: int | None = None) -> list[dict]:
        """Return a copy of recent events under ``state.lock``.

        Args:
            limit: Optional tail-length cap. ``None`` returns the full buffer.
        """
        with self.lock:
            if limit is None:
                return list(self.recent_events)
            if limit <= 0:
                return []
            return list(self.recent_events[-limit:])

    def append_recent_event(self, event: dict, max_items: int) -> None:
        """Append one event and enforce max buffer size atomically."""
        with self.lock:
            self.recent_events.append(event)
            overflow = len(self.recent_events) - max_items
            if overflow > 0:
                del self.recent_events[:overflow]

    def clear_recent_events(self) -> int:
        """Clear and return the number of removed buffered events."""
        with self.lock:
            cleared = len(self.recent_events)
            self.recent_events.clear()
            return cleared

    def find_recent_event(self, event_id: str) -> dict | None:
        """Find one event by id from newest to oldest under lock."""
        with self.lock:
            for ev in reversed(self.recent_events):
                if ev.get("event_id") == event_id:
                    return ev
        return None

    # ----- Per-slot proxies (legacy single-source accessors) -----
    # Every read here delegates to the primary slot. Writes that mutate
    # objects in place (``state.episodes[key] = ...``) work because the
    # property returns the live dict reference.
    @property
    def primary_slot(self) -> StreamSlot:
        slot = self.slots.get(self.PRIMARY_ID)
        if slot is not None:
            return slot
        if self.slots:
            # ``primary`` was removed but other slots remain — pick any so
            # legacy ``state.X`` access has a target.
            return next(iter(self.slots.values()))
        # Registry is empty (operator removed every slot). Re-create an
        # empty placeholder so legacy property accesses keep working.
        placeholder = StreamSlot(self.PRIMARY_ID, "Primary", DEFAULT_SOURCE)
        self.slots[self.PRIMARY_ID] = placeholder
        return placeholder

    @property
    def reader(self) -> StreamReader | None:
        return self.primary_slot.reader

    @reader.setter
    def reader(self, v):
        self.primary_slot.reader = v

    @property
    def track_history(self):
        return self.primary_slot.track_history

    @property
    def episodes(self):
        return self.primary_slot.episodes

    @property
    def pair_cooldown(self):
        return self.primary_slot.pair_cooldown

    @property
    def quality(self):
        return self.primary_slot.quality

    @property
    def last_perception_state(self):
        return self.primary_slot.last_perception_state

    @last_perception_state.setter
    def last_perception_state(self, v):
        self.primary_slot.last_perception_state = v

    @property
    def ego(self):
        return self.primary_slot.ego

    @property
    def scene(self):
        return self.primary_slot.scene

    @property
    def last_ego_flow(self):
        return self.primary_slot.last_ego_flow

    @last_ego_flow.setter
    def last_ego_flow(self, v):
        self.primary_slot.last_ego_flow = v

    @property
    def last_scene_ctx(self):
        return self.primary_slot.last_scene_ctx

    @last_scene_ctx.setter
    def last_scene_ctx(self, v):
        self.primary_slot.last_scene_ctx = v

    @property
    def _frame_lock(self):
        return self.primary_slot._frame_lock

    @property
    def _annotated_jpeg(self):
        return self.primary_slot._annotated_jpeg

    @_annotated_jpeg.setter
    def _annotated_jpeg(self, v):
        self.primary_slot._annotated_jpeg = v

    @property
    def _frame_detections(self):
        return self.primary_slot._frame_detections

    @_frame_detections.setter
    def _frame_detections(self, v):
        self.primary_slot._frame_detections = v

    @property
    def _frame_ts(self):
        return self.primary_slot._frame_ts

    @_frame_ts.setter
    def _frame_ts(self, v):
        self.primary_slot._frame_ts = v


# Module-level singleton. Import-time construction is safe because
# ``LiveState.__init__`` only builds default-constructed helpers.
state = LiveState()
