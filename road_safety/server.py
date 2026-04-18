"""Live safety review API — the "brain" of the fleet-safety dashcam system.

Pulls a live stream, runs YOLO at 2 fps in a background thread, emits typed safety
events over Server-Sent Events with an LLM-generated one-line narration, and exposes
a RAG-backed copilot endpoint over a tiny statute/policy corpus.

=============================================================================
 MODULE OVERVIEW (for readers new to the codebase)
=============================================================================

This file is a FastAPI web service. It does THREE things in parallel:

  1. A background worker thread pulls camera frames and runs perception
     (YOLO object detection + a stack of safety "gates"). This is the hot
     path. See ``_on_frame`` and ``_run_loop``-style logic below.

  2. An asyncio event loop serves HTTP + SSE (Server-Sent Events) endpoints
     that stream live detections, expose admin controls, and offer agent /
     LLM features. See the ``@app.get(...)`` / ``@app.post(...)`` handlers.

  3. Several long-running background asyncio tasks (edge -> cloud publisher,
     retention sweep, score decay, watchdog) — all spawned in ``lifespan``.

KEY DOMAIN CONCEPTS
-------------------

  * GATES: a "real" conflict must pass several independent checks — depth,
    convergence, ego-relative motion, TTC (time-to-collision), and
    perception quality. Each gate kills a specific class of false positive.
    They are NOT removable; if you loosen one, noise spikes somewhere.
    See the gate order in ``_on_frame`` (numbered comments below).

  * EPISODE: repeated frames of the same risky situation for the same pair
    of tracked objects merge into a SINGLE event. The ``Episode`` class
    below accumulates peak severity across frames, then flushes ONE event
    when the pair hasn't been seen for a short idle window. This is how
    we de-duplicate across time.

  * PRIVACY INVARIANT (critical): license-plate text is hashed and STRIPPED
    at ingest inside ``services/llm.py::enrich_event``. ``server.py``
    additionally pops ``plate_text`` / ``plate_state`` at egress as
    defence-in-depth — see ``_emit_event`` below. Raw plate text must
    NEVER enter any in-memory buffer, SSE channel, Slack message, or
    cloud payload.

  * DUAL THUMBNAILS: every event writes two JPEGs:
        ``<id>.jpg``        — internal, unredacted (DSAR-gated access)
        ``<id>_public.jpg`` — redacted (faces + plates blurred)
    All shared channels (SSE, Slack, cloud) get ONLY the ``_public`` copy.
    The internal copy is served only to a caller presenting a valid
    ``X-DSAR-Token`` header.

  * AUTH TIERS (enforced per endpoint):
        public        — SSE, redacted thumbs, dashboard reads.
        X-DSAR-Token  — unredacted thumbnail retrieval (Data Subject
                        Access Request workflow).
        Admin bearer  — audit logs, LLM observability, road registry,
                        agents, retention, active-learning. The token is
                        read from the ``ROAD_ADMIN_TOKEN`` env var.
    Each HTTP endpoint's docstring below is labelled with its tier.

PYTHON IDIOMS USED IN THIS FILE (explained on first appearance)
---------------------------------------------------------------
  * ``from __future__ import annotations`` — defers evaluation of type
    annotations so forward references like ``list[int] | None`` work on
    older Python versions at runtime.
  * ``@asynccontextmanager`` (from ``contextlib``) — turns an async
    generator into a manager usable with ``async with``. FastAPI uses
    this for startup / shutdown ("lifespan") hooks.
  * ``async def`` / ``await`` — coroutines. They only run inside an
    event loop (here: the uvicorn asyncio loop). ``await X`` yields
    control back to the loop until ``X`` finishes.
  * ``asyncio.Queue`` — FIFO queue safe for producer/consumer across
    coroutines; used for SSE fan-out to subscribers.
  * ``asyncio.run_coroutine_threadsafe(coro, loop)`` — schedule an async
    coroutine FROM a non-async thread (we use this to hand results from
    the perception thread back to the main loop).
  * ``threading.Lock`` — mutual exclusion so the perception thread and
    HTTP handlers don't read half-written frame state at the same time.
  * ``@app.get("/path")`` / ``@app.post(...)`` — FastAPI decorators that
    register the function below as an HTTP route.
  * ``Request`` / ``StreamingResponse`` / ``FileResponse`` /
    ``HTTPException`` — FastAPI primitives: request object, chunked
    streaming response body, static file response, and the exception
    that converts into an HTTP error.
  * f-string (``f"text {var}"``) — inline string interpolation.
  * ``list[X] | None`` / ``dict[K, V]`` — PEP 604 union + PEP 585 generics.
  * Comprehensions (``[x for x in xs if ...]``) — compact list/dict/set
    construction.
  * ``try/except/finally`` — exception handling with an always-run
    ``finally`` block.
  * Module-level ``state = LiveState()`` — a single process-wide singleton
    holding the live perception state. Do NOT create a second one.
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


# ===== SECTION: IMPORTS DONE. LOGGING CONFIGURED. =====
# Everything above is pure wiring — bring the dependencies into scope and
# configure structured logging (``setup_logging``) so every module uses the
# same formatter. ``log`` is a module-scoped logger; never ``print``.

# ===== SECTION: FLEET IDENTITY RESOLUTION =====
# Events are meaningless to downstream fleet analytics if they can't be
# attributed to a specific vehicle / road / driver. We resolve identity ONCE
# at import time; the results are frozen into module-level constants below
# and stamped onto every emitted event in ``_flush_episode``.


# Resolved fleet identity — every emitted event MUST carry a non-empty
# vehicle_id / road_id / driver_id or downstream fleet aggregation is
# broken (events appear as "unidentified"). If the operator didn't set the
# env vars, fall back to a stable hostname-derived default and warn loudly
# at startup so the deployment is obviously misconfigured instead of
# silently producing unattributable events.
def _resolve_identity() -> tuple[str, str, str, list[str]]:
    """Return the effective fleet identity for this process, plus any gaps.

    Reads ``VEHICLE_ID`` / ``ROAD_ID`` / ``DRIVER_ID`` (sourced from env in
    ``road_safety/config.py``). If any is missing, substitutes a stable
    hostname-derived placeholder so events still emit — but also records
    the missing env-var names so ``lifespan`` can log a loud warning.

    Returns:
        A 4-tuple ``(vehicle_id, road_id, driver_id, missing_env_vars)``.
        ``missing_env_vars`` is the list of env var names that were empty
        (e.g. ``["ROAD_VEHICLE_ID"]``) — empty means fully configured.
    """
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


class LiveState:
    """Process-wide in-memory state for the live safety pipeline.

    This class does not own a lock at the object level — instead, specific
    mutable-from-multiple-threads fields (``_annotated_jpeg``,
    ``_frame_detections``, ``_frame_ts``) are guarded by ``_frame_lock``,
    and the asyncio-side collections (``subscribers``,
    ``admin_detection_subscribers``, ``recent_events``) are only mutated
    from the asyncio loop. The perception thread hands results to the
    loop via ``asyncio.run_coroutine_threadsafe``.

    Lifecycle:
        * Constructed at module import time.
        * ``lifespan`` populates ``loop``, ``model``, ``reader``,
          ``agent_executor``, ``watchdog`` on startup.
        * On shutdown, ``lifespan`` cancels background tasks and stops
          the stream reader.
    """

    def __init__(self):
        """Initialise all fields to their pre-startup empty state."""
        # Loaded YOLO model object — populated in ``lifespan``.
        self.model = None
        # Background frame reader (HLS / file / webcam / YouTube).
        self.reader: StreamReader | None = None
        # Human-readable label of the source the operator asked for.
        self.source_label: str = DEFAULT_SOURCE
        # The running asyncio event loop. Captured in ``lifespan`` so the
        # perception thread can schedule coroutines onto it.
        self.loop: asyncio.AbstractEventLoop | None = None
        # Rolling buffer of fully-enriched events (capped at
        # MAX_RECENT_EVENTS). This is the source-of-truth for HTTP reads
        # and drift analysis. A list (not deque) — O(1) append + O(1)
        # slice semantics are enough at this cap.
        self.recent_events: list[dict] = []
        # Set of asyncio queues — one per connected SSE client. Broadcasts
        # iterate a *copy* (``list(...)``) so disconnecting clients don't
        # mutate-during-iteration.
        self.subscribers: set[asyncio.Queue] = set()
        # Monotonically increasing counter mixed into the event_id so
        # multiple events in the same millisecond don't collide.
        self.event_counter = 0
        # Per-track trailing window (positions + timestamps) used by TTC
        # estimators. See ``core/detection.py::TrackHistory``.
        self.track_history = TrackHistory()
        # Active episodes keyed by canonical pair tuple. Entries live only
        # while the pair is actively interacting; flushed after
        # EPISODE_IDLE_FLUSH_SEC of absence.
        self.episodes: dict[tuple[int, int], Episode] = {}
        # Per-pair cooldown timestamps. After a pair emits, the same
        # pair is muted for PAIR_COOLDOWN_SEC to avoid re-alerting while
        # the same objects remain in-frame.
        self.pair_cooldown: dict[tuple[int, int], float] = {}
        # Perception-quality monitor — detects night/rain/glare/dirty lens.
        self.quality = QualityMonitor()
        # Last broadcast perception state so we only emit a control-plane
        # SSE message when the state actually transitions.
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
        # The perception thread WRITES these; HTTP handlers READ them.
        # A ``threading.Lock`` guards the triplet because bytes / list / float
        # writes are not atomic on CPython if read in the middle of an update.
        self._frame_lock = threading.Lock()
        self._annotated_jpeg: bytes | None = None
        self._frame_detections: list[dict] = []
        self._frame_ts: float = 0.0
        # Separate subscriber set — admin detection snapshots are a
        # noisier channel than the public safety-event SSE.
        self.admin_detection_subscribers: set[asyncio.Queue] = set()


# Module-level singleton. Import-time construction is safe because
# ``LiveState.__init__`` only builds default-constructed helpers.
state = LiveState()


# ===== SECTION: HELPERS (auth, thumb signing, utility coroutines) =====


def _require_admin(request: Request, realm: str = "admin") -> None:
    """Enforce the admin-bearer auth tier or raise 401.

    Wraps ``security.require_bearer_token`` with this module's constant
    admin token. Called at the top of every admin-tier endpoint.

    Args:
        request: The FastAPI request object (carries the Authorization header).
        realm: Human-readable label included in the 401 response so the
            UI can explain which scope was denied.

    Raises:
        HTTPException: 401 Unauthorized if the bearer token is missing
            or incorrect.
    """
    require_bearer_token(
        request,
        ADMIN_TOKEN,
        realm=realm,
        env_var="ROAD_ADMIN_TOKEN",
    )


async def _none_coro():
    """Trivial coroutine that yields ``None``.

    Used as a sentinel "no enrichment to run" task so the ``asyncio.gather``
    in ``_emit_event`` always has two awaitables regardless of whether we
    actually called the LLM enrichment path.
    """
    return None


def _thumb_token(name: str, expiry: int) -> str:
    """Produce a 32-hex-char HMAC tag binding ``name`` to an expiry time.

    Args:
        name: Thumbnail filename (e.g. ``evt_1234_0001_public.jpg``).
        expiry: Unix-epoch second at which this token stops being valid.

    Returns:
        The first 32 hex characters of the SHA-256 HMAC. 128 bits is more
        than enough entropy for a short-lived signed URL.
    """
    mac = hmac.new(
        THUMB_SIGNING_SECRET.encode("utf-8"),
        f"{name}.{expiry}".encode("utf-8"),
        hashlib.sha256,
    )
    return mac.hexdigest()[:32]


def _valid_thumb_request(name: str, request: Request) -> bool:
    """Check whether the signed-URL query params on a public-thumb fetch are valid.

    Args:
        name: Thumbnail filename from the URL path.
        request: The FastAPI request (to read ``?exp=`` + ``?token=``).

    Returns:
        True iff:
          * Token-gating is disabled entirely via config, OR
          * A signing secret is configured, AND the request carries
            ``exp`` + ``token`` query params, AND ``exp`` is in the
            future (but not more than 24h ahead), AND the HMAC matches.
    """
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
    # WHY 24h: a leaked URL with a 30-day expiry is a de facto permanent
    # bypass; capping exposure at ~1 day limits blast radius.
    if exp > now + (24 * 60 * 60):
        return False
    expected = _thumb_token(name, exp)
    # ``hmac.compare_digest`` is constant-time — prevents timing-oracle
    # attacks that would otherwise leak the correct token byte-by-byte.
    return hmac.compare_digest(expected, token)


async def _score_decay_loop(interval_sec: int) -> None:
    """Long-running background task: periodically decay driver safety scores.

    The driver-score model in ``services/registry.py`` decays over time so
    yesterday's bad trip doesn't permanently dominate today's score. This
    loop triggers that decay on a fixed cadence.

    Args:
        interval_sec: Seconds between decay passes. Sourced from
            ``ROAD_SCORE_DECAY_INTERVAL_SEC``; 0 disables the loop
            entirely (handled by the caller in ``lifespan``).

    Raises:
        asyncio.CancelledError: Re-raised on shutdown so the task cleanly
            terminates when ``lifespan`` cancels it.
    """
    while True:
        try:
            await asyncio.sleep(interval_sec)
            road_registry.decay_scores()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Narrow log-and-continue: one failed decay pass shouldn't
            # take the whole loop down — the next cycle retries cleanly.
            log.warning("score decay loop failed: %s", exc)


def _pair_key(event_type: str, a, b) -> tuple | None:
    """Canonical pair key for an interaction. Returns None if either side has
    no track_id — in which case we fall back to type-level dedup.

    Args:
        event_type: The interaction category (e.g. ``"pedestrian_proximity"``).
        a, b: The two ``Detection`` objects in the interaction.

    Returns:
        ``(event_type, lo_track_id, hi_track_id)`` with the track-ids
        sorted so (A, B) and (B, A) map to the same episode. Returns
        ``None`` when either detection lacks a track id (object only
        appeared in a single frame) — caller falls back to a time-bucket
        key so we still dedup across a short window.
    """
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

    Args:
        ttc_sec: Time-to-collision in seconds, or ``None`` if unknown.
        distance_m: 3D distance in metres, or ``None``.
        fallback_px: 2D pixel distance — used only when both of the
            above are unknown, as a last-resort proxy.
        thr: ``AdaptiveThresholds`` dataclass (scene-adapted: different
            numbers for urban vs highway vs parking).
        ego_speed_mps: Optical-flow-derived ego speed proxy, or ``None``
            when confidence is too low to trust.
        any_track_approaching: True if at least one track shows a
            positive ego-relative approach residual. Required to lift
            the low-speed floor.

    Returns:
        ``"low"`` / ``"medium"`` / ``"high"``. Never returns "unknown" —
        when all inputs are missing, defaults to "low".
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
        # Pixel fallback thresholds (60 / 180 px) are deliberately
        # conservative — only used when every other signal is missing.
        # They exist so a naive integration with no depth estimate at
        # all still produces something rather than silently swallowing
        # everything.
        if fallback_px <= 60:
            levels.append("high")
        elif fallback_px <= 180:
            levels.append("medium")

    # Highest tier wins across all priority levels.
    risk = "low"
    if "high" in levels:
        risk = "high"
    elif "medium" in levels:
        risk = "medium"

    # Speed-aware floor: in low-speed regimes (red light, traffic jam,
    # parking), close-quarters proximity is normal. Cap at medium unless
    # there is independent evidence of approach (ego-motion residual).
    # WHY this gate matters: without it, any stopped-at-a-light event with
    # a car within 2m was firing "high" — the single biggest source of
    # alert fatigue in early field tests.
    if (
        risk == "high"
        and ego_speed_mps is not None
        and ego_speed_mps < LOW_SPEED_FLOOR_MPS
        and not any_track_approaching
    ):
        return "medium"
    return risk


def _render_annotated_frame(frame, detections, interactions):
    """Draw bounding boxes and labels on a copy of the frame for the admin feed.

    This is a purely visual helper — the output is fed only to the MJPEG
    admin video feed, not to any compliance-sensitive channel. It operates
    on a COPY so the perception pipeline's shared frame is not mutated.

    Args:
        frame: Raw BGR numpy image.
        detections: Iterable of ``Detection`` dataclasses (with ``.x1/.y1
            /.x2/.y2``, ``.cls``, ``.conf``, ``.track_id``, ``.center``).
        interactions: Iterable of ``(event_type, det_a, det_b, dist_px)``
            tuples — render as coloured connecting lines between pairs.

    Returns:
        JPEG-encoded bytes (quality 70 — small enough for MJPEG but
        readable for operators).
    """
    vis = frame.copy()
    # BGR colour map (OpenCV uses BGR, not RGB). Anything unrecognised
    # falls back to neutral grey.
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


# ===== SECTION: PERCEPTION HOT PATH =====
# ``_on_frame`` is called by ``StreamReader`` in a background thread at
# approximately ``TARGET_FPS`` Hz (default 2). It must do ALL the CPU-bound
# perception work AND ensure results reach the asyncio loop without blocking
# it. Every safety-critical "gate" lives here — see the numbered list in
# the docstring below. If you touch this function, run ``tests/test_core.py``.


def _on_frame(wall_ts: float, frame) -> None:
    """Perception hot path — runs in the StreamReader background thread.

    CPU-bound YOLO + gate evaluation happens here. Results are handed to
    the asyncio loop via ``asyncio.run_coroutine_threadsafe``; we never
    block that loop with the heavy work.

    Args:
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

    # ----- Gate 1: tracked detection (YOLO + ByteTrack) -----
    detections = detect_frame(state.model, frame)
    frame_h = frame.shape[0]  # image height — needed by pinhole distance estimates.

    # ----- Gate 2: perception-quality observer -----
    # Feed every frame so degradations (night, rain, glare, dirty lens)
    # flip the pipeline into conservative mode. ``risk_adjustment`` returns
    # multipliers applied below; ``state()`` is a human-readable summary we
    # broadcast over SSE when it transitions.
    state.quality.observe_frame(frame, detections, wall_ts)
    adj = state.quality.risk_adjustment()
    qstate = state.quality.state()
    if qstate["state"] != state.last_perception_state and state.loop is not None:
        state.last_perception_state = qstate["state"]
        # ``run_coroutine_threadsafe`` is the official bridge from a
        # worker thread to the asyncio loop. We schedule and forget —
        # the returned Future is not awaited here.
        asyncio.run_coroutine_threadsafe(_broadcast_perception(qstate), state.loop)

    # ----- Gate 3: ego-motion estimation -----
    # Farneback dense optical flow on the masked background → ego flow vector
    # + speed proxy. Ego-motion lets downstream code tell "object approaching
    # me" apart from "I'm approaching a parked object." Also feeds scene
    # context. Wrapped in try/except because optical flow can fail on tiny /
    # degenerate frames and we don't want one bad frame to crash the thread.
    try:
        ego_flow = state.ego.update(frame, detections, wall_ts)
    except Exception as exc:
        log.warning("ego-motion update failed: %s", exc)
        ego_flow = None
    state.last_ego_flow = ego_flow

    # ----- Gate 4: scene context + adaptive thresholds -----
    # Classify urban / highway / parking from rolling detection density +
    # ego speed. Thresholds adapt per scene so 65mph highway doesn't reuse
    # city-street numbers.
    # WHY the 0.4 confidence floor: only feed the speed proxy in when ego-
    # flow confidence is high enough that the median flow is reliable.
    # Below this band (rain, wipers, low texture, pure rotation) we let the
    # classifier fall back to detection-density rules rather than driving
    # adaptive thresholds off a noisy speed estimate — that's how "highway"
    # mistakenly fires in parking lots with reflective floors.
    if ego_flow is not None and ego_flow.confidence >= 0.4:
        speed_proxy = ego_flow.speed_proxy_mps
    else:
        speed_proxy = None
    state.scene.observe(detections, wall_ts, speed_proxy_mps=speed_proxy)
    scene_ctx = state.scene.classify()
    state.last_scene_ctx = scene_ctx
    thr = state.scene.adaptive_thresholds(scene_ctx)

    # ----- Gate 5: update per-track history -----
    # ``live_ids`` is the set of tracks still present THIS frame; ``prune``
    # evicts older ones from the rolling history so memory doesn't grow
    # unbounded as tracks come and go.
    live_ids: set[int] = set()
    for det in detections:
        if det.track_id is not None:
            live_ids.add(det.track_id)
            state.track_history.update(det, wall_ts)
    state.track_history.prune(live_ids, wall_ts)

    # ----- Gate 6: candidate interaction generation -----
    interactions = find_interactions(detections)
    # Track which pair keys we've seen this frame so the idle-flush below
    # can correctly identify "absent for long enough to close" pairs.
    seen_pairs_this_frame: set[tuple] = set()

    for event_type, a, b, distance_px in interactions:
        # Pull the trailing-window samples for both tracks — needed for
        # TTC and convergence checks. May be empty for brand-new tracks.
        hist_a = state.track_history.samples(a.track_id)
        hist_b = state.track_history.samples(b.track_id)

        # Inter-object distance (depth difference + lateral offset), not
        # single-object range-to-camera. Fall back to per-object range if
        # the pair-wise estimator can't produce a value.
        dist_m = estimate_inter_distance_m(a, b, frame_h)
        if dist_m is None:
            for sub in (a, b):
                cand = estimate_distance_m(sub, frame_h)
                if cand is not None and (dist_m is None or cand < dist_m):
                    dist_m = cand

        # ----- Gate 7 + 8: depth + convergence (vehicle-vehicle only) -----
        # Depth-aware proximity for vehicle-vehicle pairs. Two cars more than
        # VEHICLE_INTER_DISTANCE_GATE_M apart in 3D are not a close interaction
        # even when their bboxes overlap in the image plane — perspective
        # overlap of distant objects is not collision risk.
        if event_type == "vehicle_close_interaction":
            if dist_m is not None and dist_m > VEHICLE_INTER_DISTANCE_GATE_M:
                continue
            # Convergence filter: reject parallel / same-direction traffic.
            # Two cars in adjacent lanes moving the same direction at the
            # same speed are not a conflict — only *converging* tracks are.
            if not tracks_converging(hist_a, hist_b):
                continue

        # ----- Gate 9: ego-relative motion -----
        # If neither track shows a positive approach residual against the
        # optical-flow ego-motion estimate, TTC from bbox noise alone is
        # not a conflict — discard it.
        approaching_a = approaching_b = False
        if ego_flow is not None:
            try:
                rm_a = state.ego.relative_motion(a.track_id, a, ego_flow, state.track_history)
                rm_b = state.ego.relative_motion(b.track_id, b, ego_flow, state.track_history)
                # ``bool(rm and rm.approaching)`` handles both None and False
                # uniformly — we need a strict bool for the OR below.
                approaching_a = bool(rm_a and rm_a.approaching)
                approaching_b = bool(rm_b and rm_b.approaching)
            except Exception as exc:
                log.debug("relative_motion failed: %s", exc)
        any_approaching = approaching_a or approaching_b

        # ----- Gate 10: pair TTC (fallback: per-object) -----
        # Pair-wise TTC from closing rate between the two tracks (SSAM method).
        # Falls back to per-object scale-expansion TTC if pair TTC unavailable.
        # We keep the MINIMUM (most urgent) across the two fallbacks.
        ttc = estimate_pair_ttc(hist_a, hist_b)
        if ttc is None:
            for sub in (a, b):
                hist = state.track_history.samples(sub.track_id)
                cand = estimate_ttc_sec(hist)
                if cand is not None and (ttc is None or cand < ttc):
                    ttc = cand

        # ----- Gate 11: approach-required TTC scrub -----
        # If a TTC value passed the upstream gates but neither track shows
        # an approach residual, treat it as unreliable and discard. Distance
        # and edge-pixel gates still apply.
        if ttc is not None and ego_flow is not None and not any_approaching:
            ttc = None

        # ----- Gate 12: quality-adjusted classification -----
        # Divide effective TTC / px to tighten thresholds when perception is
        # degraded (earlier triggers, more cautious). ``adj`` multipliers
        # come from ``QualityMonitor``; they are ``1.0`` in nominal state.
        eff_ttc = ttc / adj["ttc_multiplier"] if ttc is not None else None
        eff_px = distance_px / adj["pixel_dist_multiplier"]
        ego_speed_mps = ego_flow.speed_proxy_mps if ego_flow is not None else None
        risk = _classify_with_scene(
            eff_ttc, dist_m, eff_px, thr,
            ego_speed_mps=ego_speed_mps,
            any_track_approaching=any_approaching,
        )
        # ----- Gate 13: per-type floor -----
        # Pedestrians deserve tighter attention, but a low-risk person on
        # the other side of the street is not worth an event. Require at
        # least medium for this type before we even consider emitting.
        if event_type == "pedestrian_proximity" and risk == "low":
            continue

        # ----- Gate 14: cooldown check -----
        key = _pair_key(event_type, a, b)
        if key is None:
            # Untracked fallback — synthesise a per-frame key so we still
            # dedup within a short window without a stable pair identity.
            # ``int(wall_ts)`` buckets to a 1s window.
            key = (event_type, "no_track", int(wall_ts))

        cooldown_until = state.pair_cooldown.get(key, 0.0)
        if wall_ts < cooldown_until:
            continue

        # ----- Gate 15: episode open / update -----
        seen_pairs_this_frame.add(key)
        ep = state.episodes.get(key)
        if ep is None:
            ep = Episode(event_type, key, wall_ts)
            state.episodes[key] = ep
        ep.update(frame, detections, a, b, distance_px, ttc, dist_m, risk, wall_ts)

    # ----- Gate 16: idle-flush episodes -----
    # Iterate over a *snapshot* of keys because we mutate the dict below.
    # When a pair has gone EPISODE_IDLE_FLUSH_SEC without a fresh frame,
    # we emit the one peak event and start a cooldown window to prevent
    # re-alerting on the same objects if they re-appear shortly after.
    for key in list(state.episodes.keys()):
        ep = state.episodes[key]
        if key in seen_pairs_this_frame:
            continue
        if wall_ts - ep.last_seen_at >= EPISODE_IDLE_FLUSH_SEC:
            _flush_episode(ep, wall_ts)
            state.episodes.pop(key, None)
            state.pair_cooldown[key] = wall_ts + PAIR_COOLDOWN_SEC

    # ----- Admin video feed + detections broadcast -----
    # Non-safety-critical visualization. Wrapped in try/except so a JPEG
    # encoding failure does not break the perception loop for the next frame.
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


# ===== SECTION: EVENT MATERIALIZATION (EPISODE -> TYPED EVENT DICT) =====


def _flush_episode(ep: Episode, wall_ts: float) -> None:
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
        * Schedules ``_emit_event`` on the asyncio loop.
        * Sets ``ep.emitted = True`` so repeated flush calls are no-ops.

    Args:
        ep: The ``Episode`` being flushed.
        wall_ts: Current wall-clock timestamp (unused inside the body but
            kept for call-site symmetry with the idle-flush check).
    """
    if ep.emitted or ep.peak_frame is None:
        return
    ep.emitted = True

    # Sustained-risk downgrade — see Episode.final_risk().
    final_risk = ep.final_risk()
    risk_demoted = final_risk != ep.peak_risk

    # Event id format: ``evt_<ms-since-epoch>_<4-digit-counter>`` — roughly
    # sortable and globally unique per process. ``:04d`` is a format-spec
    # that zero-pads the integer to 4 digits.
    state.event_counter += 1
    event_id = f"evt_{int(ep.started_at * 1000)}_{state.event_counter:04d}"
    internal_name = f"{event_id}.jpg"
    public_name = public_thumbnail_name(internal_name)

    # PRIVACY INVARIANT: ``write_thumbnails`` is the ONLY place both JPEGs
    # are produced. The internal copy stays on disk behind DSAR-gating;
    # the public copy has faces + plates blurred. Shared channels MUST
    # only reference the public copy.
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
    # ``stream_t`` is seconds-since-stream-start; handy for aligning an
    # event back to a recorded video file. Falls back to 0 when there is
    # no active reader (single-shot test mode).
    stream_t = ep.started_at - (state.reader.started_at if state.reader else ep.started_at)
    # Filter out None track ids (untracked fallback case).
    pair_ids = [tid for tid in (a.track_id, b.track_id) if tid is not None]
    duration_sec = round(ep.last_seen_at - ep.started_at, 2)

    scene_ctx = state.last_scene_ctx
    ego = state.last_ego_flow
    # ===== Typed event dict — the canonical wire format =====
    # Every field here is part of the public contract with downstream
    # consumers (dashboard, Slack, cloud). If you rename a field, grep
    # for it in frontend/ and cloud/ first.
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
        # Anyone rendering this URL gets the redacted thumbnail. DSAR
        # workflows must request the internal ``evt_*.jpg`` by name and
        # authenticate with ``X-DSAR-Token``.
        "thumbnail": f"thumbnails/{public_name}",
    }

    # Hand off to the asyncio loop — LLM enrichment + SSE broadcast + Slack
    # dispatch all happen there, not in this background thread.
    asyncio.run_coroutine_threadsafe(_emit_event(event, internal_name), state.loop)


# ===== SECTION: SSE BROADCAST HELPERS =====
# Each connected client has its own ``asyncio.Queue``. Broadcast = iterate
# the subscriber set and ``put_nowait`` on each queue. ``QueueFull`` is
# swallowed so a single slow consumer can't back-pressure the whole fan-out.


async def _broadcast_perception(qstate: dict) -> None:
    """Broadcast a perception-state change as a control-plane SSE message.

    Uses a sentinel ``_meta: "perception_state"`` so the UI can render a
    banner without confusing these with safety events.

    Args:
        qstate: A dict from ``QualityMonitor.state()`` describing the new
            perception state (nominal / degraded / blind, plus reason text).
    """
    # ``**qstate`` unpacks the dict into kwargs at literal-construction
    # time — merges the ``_meta`` tag with the fields. Python's dict
    # unpacking syntax ``{**a, **b}`` is equivalent to ``a | b`` on 3.9+.
    msg = {"_meta": "perception_state", **qstate}
    # ``list(state.subscribers)`` snapshots the set so a concurrent
    # disconnect can't mutate what we're iterating over.
    for q in list(state.subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            # Dropping a message is preferable to blocking the broadcast
            # on one stuck subscriber. Client will resync on next event.
            pass


async def _broadcast_admin_detections(msg: dict) -> None:
    """Fan out a per-frame detection snapshot to admin-dashboard SSE clients.

    Args:
        msg: Pre-serialised snapshot built in ``_on_frame`` — counts plus
            the list of object boxes for the current frame.
    """
    for q in list(state.admin_detection_subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


# ===== SECTION: ASYNC EVENT EMISSION (ENRICH + BROADCAST + EGRESS) =====


async def _emit_event(event: dict, internal_thumb_name: str) -> None:
    """Runs on the main asyncio loop. Narrates + enriches (parallel), then broadcasts.

    ALPR runs against the *internal* (unredacted) thumbnail because we need
    the plate text to hash it. The raw plate string is then discarded —
    only the salted hash survives into the egress payload. This is the
    key compliance boundary: plate text never reaches Slack, the SSE feed,
    or the recent-events buffer.

    Args:
        event: The typed event dict built by ``_flush_episode``. Mutated
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
    #       Default is ``off`` — no external ALPR call, ever.
    #   (b) perception is degraded — low-SNR image, money wasted.
    #   (c) low-risk events — weekly-batch review SLA, ALPR adds little value.
    # This prevents unnecessary external calls before rate limiting even
    # starts. The reason string is surfaced on the event so dashboards
    # can explain *why* enrichment was skipped.
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

    # ``asyncio.gather`` runs both coroutines concurrently; the call
    # completes when BOTH finish. Narration ~200ms; enrichment ~500ms.
    # Running them in parallel cuts the critical path in half.
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
        # different enrichment source — the invariant "no raw plate in
        # the event buffer" is enforced twice. Any future enrichment
        # provider MUST respect this.
        enrichment.pop("plate_text", None)
        enrichment.pop("plate_state", None)
        event["enrichment"] = enrichment

    # Append to rolling buffer, evicting oldest when we exceed the cap.
    # A plain list is fine at ``MAX_RECENT_EVENTS`` (usually ~500) — at
    # that size the O(n) pop(0) cost is negligible compared to the rest
    # of the pipeline, and list has better random-access semantics than
    # deque for the slicing read paths below.
    state.recent_events.append(event)
    if len(state.recent_events) > MAX_RECENT_EVENTS:
        state.recent_events.pop(0)

    # Road registry — track per-vehicle event counts + safety score.
    road_registry.record_event(event)

    # Fan out the event to every SSE subscriber. Same pattern as
    # ``_broadcast_perception`` — drop on QueueFull, never block.
    for q in list(state.subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass

    # Slack gets the redacted (public) thumbnail — never the internal one.
    # ``asyncio.create_task`` schedules the coroutine without awaiting it,
    # so a slow Slack webhook does not delay the next perception frame's
    # event emission.
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


# ===== SECTION: APP LIFESPAN (startup + shutdown orchestration) =====
# FastAPI's ``lifespan`` is an async context manager invoked once per process:
# everything BEFORE the ``yield`` runs at startup; everything AFTER runs at
# shutdown. Startup here does a lot of work — model loading, stream
# resolution, launching background tasks. Shutdown cancels those tasks.
#
# Python note: ``@asynccontextmanager`` turns a single async generator
# (``async def ... yield ...``) into a usable ``async with`` manager.
# The function must yield EXACTLY ONCE; code before the yield runs on
# ``__aenter__``, code after on ``__aexit__``.


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI startup + shutdown hook.

    Startup (pre-yield):
        * Captures the running event loop for the perception thread.
        * Warns if fleet identity is missing.
        * Loads the YOLO model.
        * Resolves the HLS URL + starts the StreamReader thread.
        * Starts digest schedulers, edge publisher, retention sweep loop,
          score decay loop, test runner, and the AI watchdog.
        * Constructs the agent executor (needs a live event-lookup).

    Shutdown (post-yield):
        * Stops the stream reader.
        * Cancels every long-running asyncio task.

    Args:
        app: The FastAPI application instance (unused here; required by
            the lifespan signature).
    """
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
    # Collects a snapshot of the system's health periodically and fingerprints
    # repeated issues into an incident queue (not a log-tail wall of red).
    watchdog_task = None
    if WATCHDOG_ENABLED:
        def _collect_snapshot() -> dict:
            """Build the point-in-time health snapshot for the watchdog.

            Pulled from closures over ``state`` / ``llm_observer``. Returned
            dict structure is owned by the watchdog — adding a field is
            fine, renaming requires updating the watchdog rules.
            """
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

    # ----- Yield control to the running app -----
    # While yielded, FastAPI serves requests. When the process receives a
    # shutdown signal, control returns here for cleanup.
    yield

    # ----- Shutdown: cancel every background task we started -----
    # ``cancel()`` on an asyncio.Task raises CancelledError inside the
    # coroutine at its next await point; the tasks above all handle this
    # by re-raising (clean exit).
    if state.reader:
        state.reader.stop()
    if edge_task is not None:
        edge_task.cancel()
    retention_task.cancel()
    if score_decay_task is not None:
        score_decay_task.cancel()
    if watchdog_task is not None:
        watchdog_task.cancel()


# ===== SECTION: FASTAPI APP CONSTRUCTION + STATIC MOUNTS =====

app = FastAPI(title="Live Safety Review", lifespan=lifespan)

THUMBS_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

def _find_event(event_id: str) -> dict | None:
    """Locate an event by id in the recent-events buffer.

    Searches newest-first (``reversed``) because the most recent events
    are the ones an operator is likely querying.

    Args:
        event_id: The ``evt_...`` id produced by ``_flush_episode``.

    Returns:
        The event dict if found, else ``None``.
    """
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

    Args:
        record: The feedback payload as posted to ``/api/feedback``
            (verdict, optional note, event_id).
        matched: The matched event dict from ``state.recent_events``, or
            ``None`` if feedback references an event that has already
            rolled off the buffer.
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
# The routes themselves live in ``road_safety/api/feedback.py`` — this call
# bolts them onto this app and wires our ``_on_feedback`` hook for drift
# recomputation and active-learning sampling.
mount_feedback_routes(app, on_feedback=_on_feedback, event_lookup=_find_event)


# ===== SECTION: ROUTE HANDLERS — STATIC + ROOT =====


@app.get("/")
def index():
    """Serve the SPA index.html.

    HTTP: GET /
    AUTH: public
    Returns:
        The built ``index.html`` (React app entrypoint).
    """
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
def favicon():
    """Serve the favicon if present, else 404.

    HTTP: GET /favicon.ico
    AUTH: public
    """
    path = STATIC_DIR / "favicon.ico"
    if path.exists():
        return FileResponse(path)
    raise HTTPException(404)


@app.get("/thumbnails/{name}")
def thumbnail(name: str, request: Request):
    """Serve redacted (public) thumbnails freely; gate unredacted on DSAR token.

    Public UI + Slack relay + SSE all reference ``*_public.jpg``. Requesting
    the internal unredacted ``evt_xxxx.jpg`` requires a preconfigured
    X-DSAR-Token header — the minimum viable DSAR (Data Subject Access
    Request) access workflow. With no token set in env, unredacted
    retrieval is closed entirely.

    HTTP: GET /thumbnails/{name}
    AUTH:
        * ``*_public.jpg`` — public, but requires a signed ``exp`` + ``token``
          pair when ``PUBLIC_THUMBS_REQUIRE_TOKEN`` is on.
        * Internal ``evt_*.jpg`` — requires ``X-DSAR-Token`` header.
    Args:
        name: Thumbnail filename from the URL path.
        request: FastAPI request, inspected for signing query params and
            the DSAR header.
    Returns:
        FileResponse streaming the JPEG, or raises HTTPException (400 for
        a traversal-ish name, 403 on auth fail, 404 when missing).
    Side effects:
        Every access — success or denial — is recorded to the audit log
        so a compliance reviewer can reconstruct who saw what.
    """
    # Basic path-traversal / hidden-file protection. ``THUMBS_DIR / name``
    # would otherwise happily resolve ``../../etc/passwd``.
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
    # Internal unredacted path — DSAR-token required. Absence of env var
    # closes the gate entirely (``not DSAR_TOKEN`` short-circuits).
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


# ===== SECTION: ROUTE HANDLERS — LIVE SSE + COPILOT =====


@app.get("/stream/events")
async def stream_events(request: Request):
    """Server-Sent Events feed of live safety events.

    HTTP: GET /stream/events
    AUTH: public
    Response shape: ``text/event-stream``. Each message is a JSON-
        serialised event dict on a ``data:`` line; keepalives are sent as
        ``: keepalive`` comment frames so proxies don't drop the
        connection during quiet periods.
    Lifecycle:
        * Client connects: we create a per-client ``asyncio.Queue``, add
          it to ``state.subscribers``, and immediately replay the last
          ``SSE_REPLAY_COUNT`` events from the rolling buffer.
        * While connected: ``await queue.get()`` blocks for new events.
          A 15-second timeout sends a keepalive comment to keep the
          connection open even when the pipeline is quiet.
        * On disconnect: ``finally`` removes the queue from subscribers
          so ``_emit_event`` stops fanning to it.
    """
    # ``maxsize=200`` caps a single slow consumer at 200 buffered events
    # before broadcasts start dropping to their queue. The client can
    # tell from gaps in event_id sequence that a reconnect is needed.
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    state.subscribers.add(queue)

    async def gen():
        """Async generator producing SSE frames.

        Python note: ``yield`` inside an async generator makes each
        ``yield``-ed string a chunk of the HTTP response body. FastAPI's
        ``StreamingResponse`` pipes these chunks to the client as they
        are produced.
        """
        try:
            # Replay recent buffer so a fresh client sees context, not
            # just the next new event.
            for ev in state.recent_events[-SSE_REPLAY_COUNT:]:
                yield f"data: {json.dumps(ev)}\n\n"
            while True:
                # ``Request.is_disconnected`` is how FastAPI exposes
                # "client hung up" to our coroutine.
                if await request.is_disconnected():
                    break
                try:
                    # ``wait_for`` caps the blocking get at 15s so we can
                    # emit a keepalive if the pipeline is silent.
                    ev = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    # SSE comment line (starts with ``:``) — ignored by
                    # the EventSource client, keeps proxies happy.
                    yield ": keepalive\n\n"
        finally:
            # ``finally`` always runs — guarantees subscriber cleanup
            # even if the coroutine is cancelled mid-iteration.
            state.subscribers.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat")
async def chat(body: dict):
    """Copilot endpoint — RAG-style Q&A over recent events + statute corpus.

    HTTP: POST /chat
    AUTH: public
    Request body: ``{"query": "<free-text question>"}``
    Response: ``{"answer": "<LLM-generated answer>"}``
    Side effects: audit-logs the first 200 chars of the query.
    """
    query = (body.get("query") or "").strip()
    if not query:
        raise HTTPException(400, "missing 'query'")
    # Truncate to 200 chars in the audit log — long queries may contain
    # PII from the user; we only need enough to identify the pattern.
    audit.log("chat_query", query[:200])
    answer = await llm_chat(query, state.recent_events)
    return {"answer": answer}


# ===== SECTION: ROUTE HANDLERS — LIVE STATUS + PERCEPTION + SCENE =====


@app.get("/api/live/status")
def live_status():
    """Public health + configuration snapshot for the operator UI.

    HTTP: GET /api/live/status
    AUTH: public
    Response: a large dict with source label, running flag, frame counts,
        uptime, tracker/risk-model names, and PII-redaction config.
    """
    q = state.quality.state()
    return {
        "source": state.source_label,
        "location": LOCATION,
        "running": state.reader is not None and state.reader._thread is not None and state.reader._thread.is_alive(),
        "event_count": len(state.recent_events),
        "frames_read": state.reader.frames_read if state.reader else 0,
        "frames_processed": state.reader.frames_processed if state.reader else 0,
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
    """Return the perception-quality monitor's current state.

    HTTP: GET /api/live/perception
    AUTH: public
    Returns: dict with ``state``, ``reason``, ``samples``, ``avg_confidence``,
        ``luminance``, ``sharpness`` — suitable for rendering the
        perception banner in the UI.
    """
    return state.quality.state()


@app.get("/api/live/scene")
def live_scene():
    """Current scene context (urban/highway/parking/unknown) + adaptive
    thresholds in effect right now. Useful for the UI to explain why a given
    TTC threshold is being applied.

    HTTP: GET /api/live/scene
    AUTH: public
    """
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
    structured report broken down by risk level and event_type.

    HTTP: GET /api/drift
    AUTH: public
    """
    return state.drift.compute().as_dict()


@app.post("/api/active_learning/export")
def api_active_learning_export(request: Request):
    """Bundle pending active-learning samples into a zip for Label Studio /
    CVAT import. Returns the zip path (on-disk; operator downloads it
    out-of-band) or 204 when the pool is empty.

    HTTP: POST /api/active_learning/export
    AUTH: admin bearer
    Returns: ``{"path": "<absolute-path-to-zip>"}`` or 204 no-content.
    """
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
    """Paginated read of live events with optional filters.

    HTTP: GET /api/live/events
    AUTH: public
    Query params:
        risk_level: Filter to one of "low" / "medium" / "high".
        event_type: Filter to a specific event_type string.
        limit: Return at most this many most-recent events (default 100).
    """
    items = list(state.recent_events)
    if risk_level:
        items = [e for e in items if e["risk_level"] == risk_level]
    if event_type:
        items = [e for e in items if e["event_type"] == event_type]
    # ``items[-limit:]`` grabs the tail (newest); Python slices are safe
    # even when ``limit`` exceeds len.
    return items[-limit:]


def _load_batch(name: str):
    """Read a batch-pipeline JSON artefact from DATA_DIR or raise 404.

    Used by the legacy ``/api/summary`` endpoint to serve files written
    by the offline ``analyze.py`` script. Live endpoints should read
    ``state.recent_events`` directly instead.
    """
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

    HTTP: GET /api/events
    AUTH: public
    """
    items = list(state.recent_events)
    if risk_level:
        items = [e for e in items if e.get("risk_level") == risk_level]
    if event_type:
        items = [e for e in items if e.get("event_type") == event_type]
    return items[-limit:]


@app.get("/api/events/{event_id}")
def event(event_id: str):
    """Look up a single event by id.

    HTTP: GET /api/events/{event_id}
    AUTH: public
    Raises: 404 if no matching event is in the current buffer.
    """
    for ev in state.recent_events:
        if ev.get("event_id") == event_id:
            return ev
    raise HTTPException(404, "event not found")


# ===== SECTION: ROUTE HANDLERS — LLM OBSERVABILITY (ADMIN) =====

@app.get("/api/llm/stats")
def llm_stats(request: Request, window_sec: float | None = None):
    """Aggregated LLM usage: cost, latency percentiles, error/skip rates.

    HTTP: GET /api/llm/stats
    AUTH: admin bearer
    Query params:
        window_sec: Optional rolling window. Defaults to observer's config.
    """
    _require_admin(request, "LLM observability")
    return llm_observer.stats(window_sec)


@app.get("/api/llm/recent")
def llm_recent(request: Request, limit: int = 50):
    """Raw recent LLM call records for debugging.

    HTTP: GET /api/llm/recent
    AUTH: admin bearer
    Query params:
        limit: Max records (capped at 200 server-side).
    """
    _require_admin(request, "LLM observability")
    return {"items": llm_observer.recent(min(limit, 200))}


# ===== SECTION: ROUTE HANDLERS — AUDIT LOG (ADMIN) =====

@app.get("/api/audit")
def api_audit(request: Request, limit: int = 100):
    """Tail of the audit log for compliance review.

    HTTP: GET /api/audit
    AUTH: admin bearer
    Query params:
        limit: Max records (capped at 500 server-side).
    """
    _require_admin(request, "audit log")
    return {"items": audit.tail(min(limit, 500))}


@app.get("/api/audit/stats")
def api_audit_stats(request: Request):
    """Aggregate audit counters (actions, outcomes).

    HTTP: GET /api/audit/stats
    AUTH: admin bearer
    """
    _require_admin(request, "audit log")
    return audit.stats()


# ===== SECTION: ROUTE HANDLERS — DATA RETENTION (ADMIN) =====

@app.post("/api/retention/sweep")
def api_retention_sweep(request: Request):
    """Trigger an immediate retention sweep (normally runs hourly).

    HTTP: POST /api/retention/sweep
    AUTH: admin bearer
    Returns: dict summarising files deleted by the sweep.
    """
    _require_admin(request, "retention control")
    audit.log("retention_sweep", "manual_trigger")
    return retention_sweep()


# ===== SECTION: ROUTE HANDLERS — ROAD / MULTI-VEHICLE (ADMIN) =====

@app.get("/api/road/summary")
def api_road_summary(request: Request):
    """System-wide aggregation: all vehicles, scores, event counts.

    HTTP: GET /api/road/summary
    AUTH: admin bearer
    """
    _require_admin(request, "road summary")
    return road_registry.road_summary()


@app.get("/api/road/vehicle/{vehicle_id}")
def api_road_vehicle(request: Request, vehicle_id: str):
    """Fetch details for a single vehicle.

    HTTP: GET /api/road/vehicle/{vehicle_id}
    AUTH: admin bearer
    Raises: 404 if the vehicle is not known to the registry.
    """
    _require_admin(request, "road vehicle detail")
    v = road_registry.get_vehicle(vehicle_id)
    if v is None:
        raise HTTPException(404, "vehicle not found")
    return v


@app.get("/api/road/drivers")
def api_road_drivers(request: Request, limit: int = 20):
    """Driver safety leaderboard (worst-first).

    HTTP: GET /api/road/drivers
    AUTH: admin bearer
    Query params:
        limit: Max drivers returned (capped at 100 server-side).
    """
    _require_admin(request, "driver leaderboard")
    return {"drivers": road_registry.driver_leaderboard(min(limit, 100))}


# ===== SECTION: ROUTE HANDLERS — AI AGENTS (ADMIN) =====
# Each agent is a bounded-tool LLM loop (see services/agents.py). Tool sets
# are capped at 5 to avoid tool-overload hallucination — do not widen past
# that cap without a specific reason.

@app.post("/api/agents/coaching")
async def api_agent_coaching(request: Request, body: dict):
    """Generate an AI coaching note for a specific event.

    HTTP: POST /api/agents/coaching
    AUTH: admin bearer
    Request body: ``{"event_id": "<id>"}``
    Returns: agent result dict (narrative + metadata).
    """
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
    """Run an AI investigation on a specific event.

    HTTP: POST /api/agents/investigation
    AUTH: admin bearer
    Request body: ``{"event_id": "<id>"}``
    """
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
    """Generate an AI safety summary report for the current session.

    HTTP: POST /api/agents/report
    AUTH: admin bearer
    """
    _require_admin(request, "agent report")
    if state.agent_executor is None:
        raise HTTPException(503, "agent executor not ready")
    audit.log("agent_report", "session_report")
    result = await run_report_agent(state.agent_executor)
    return result.as_dict()


# ===== SECTION: ROUTE HANDLERS — ADMIN DASHBOARD (video, health, SSE) =====
# These endpoints feed the React admin dashboard. Some are intentionally
# unauthenticated (``admin_health``, ``admin_video_feed``) because the
# dashboard itself is served behind an operator network; others are
# admin-gated where they would leak sensitive state.

@app.get("/api/admin/health")
def admin_health():
    """Comprehensive health snapshot for the admin dashboard.

    HTTP: GET /api/admin/health
    AUTH: public (dashboard metadata only)
    Returns: nested dict with server / pipeline / integrations /
        perception / scene / ego sub-objects — designed for direct
        rendering in the admin health panel.
    """
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


# ===== SECTION: ROUTE HANDLERS — WATCHDOG (INCIDENT QUEUE) =====


@app.get("/api/watchdog")
def watchdog_summary():
    """Watchdog status and finding counts.

    HTTP: GET /api/watchdog
    AUTH: public
    Returns: ``{"enabled": False}`` when the watchdog was disabled at
        startup, otherwise a status dict from ``Watchdog.status()``.
    """
    if state.watchdog is None:
        return {"enabled": False}
    return state.watchdog.status()


@app.get("/api/watchdog/recent")
def watchdog_recent(n: int = 50):
    """Most recent watchdog findings for investigation.

    HTTP: GET /api/watchdog/recent
    AUTH: public
    Query params:
        n: Max findings (capped at 200).
    """
    return watchdog_tail(min(n, 200))


@app.delete("/api/watchdog/findings")
def watchdog_delete_findings(clear_all: bool = False):
    """Delete specific findings by composite key or clear all.

    HTTP: DELETE /api/watchdog/findings
    AUTH: public (dashboard action)
    Query params:
        clear_all: If true, wipe every finding.
    Returns: ``{"deleted": <count>}``.
    """
    if clear_all:
        removed = watchdog_delete(indices=None)
        return {"deleted": removed}
    return {"deleted": 0}


@app.post("/api/watchdog/findings/delete")
async def watchdog_delete_selected(request: Request):
    """Delete selected findings by snapshot_id + ts composite keys.

    HTTP: POST /api/watchdog/findings/delete
    AUTH: public (dashboard action)
    Request body: ``{"keys": ["<snapshot_id>:<ts>", ...]}``.
    Returns: ``{"deleted": <count>}``.
    """
    body = await request.json()
    keys: list[str] = body.get("keys", [])
    if not keys:
        return {"deleted": 0}
    removed = watchdog_delete_by_id(keys)
    return {"deleted": removed}


# ===== SECTION: ROUTE HANDLERS — SPA PAGE PASSTHROUGHS =====
# All these paths serve the same React SPA entrypoint; the router inside
# the app handles the actual page switch.


@app.get("/admin")
def admin_page():
    """Serve the admin SPA page.

    HTTP: GET /admin
    AUTH: public (page shell only; data endpoints enforce their own auth)
    """
    if _REACT_BUILD:
        return FileResponse(STATIC_DIR / "index.html")
    return FileResponse(STATIC_DIR / "admin.html")

@app.get("/dashboard")
def dashboard_page():
    """Serve the dashboard SPA page.

    HTTP: GET /dashboard
    AUTH: public
    """
    if _REACT_BUILD:
        return FileResponse(STATIC_DIR / "index.html")
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/monitoring")
def monitoring_page():
    """Serve the monitoring (watchdog incident queue) SPA page.

    HTTP: GET /monitoring
    AUTH: public
    """
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/admin/video_feed")
def admin_video_feed():
    """MJPEG stream of annotated frames (bounding boxes + interaction lines).

    HTTP: GET /admin/video_feed
    AUTH: public (network-gated operator UI)
    Response: ``multipart/x-mixed-replace`` stream — each JPEG part is a
        freshly-annotated frame. Consumer renders in an ``<img>`` tag.
    """
    def generate():
        """Synchronous generator yielding MJPEG parts.

        Reads the latest annotated JPEG under ``_frame_lock``, yields it
        with the MJPEG boundary, then sleeps ~0.4s. WHY 0.4s: matches
        roughly the 2fps perception tick — any faster and we'd resend
        identical frames, wasting bandwidth.
        """
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
    """SSE stream of per-frame detection snapshots for the admin dashboard.

    HTTP: GET /admin/detections
    AUTH: public (network-gated operator UI)
    Response: ``text/event-stream`` of JSON snapshots — frame counters
        plus object bounding boxes. Much lighter than the MJPEG feed,
        suitable for charts / counters.
    """
    # Smaller queue cap than the safety-event SSE — these messages are
    # per-frame at 2Hz; a client that's 50 frames behind already lost
    # 25 seconds of data and should reconnect anyway.
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


# ===== SECTION: ROUTE HANDLERS — TEST RUNNER =====

@app.get("/api/tests/status")
def api_test_status():
    """Current test run status and results.

    HTTP: GET /api/tests/status
    AUTH: public (dashboard action)
    """
    return test_run_state.as_dict()


@app.post("/api/tests/run")
def api_test_run():
    """Trigger a new test run (if not already running).

    HTTP: POST /api/tests/run
    AUTH: public (dashboard action)
    Returns: ``{"ok": True}`` when started, or ``{"ok": False,
        "reason": "already running"}`` when a run is already in flight.
    """
    if test_run_state.status == "running":
        return {"ok": False, "reason": "already running"}
    start_test_run()
    return {"ok": True}


# ===== SECTION: ROUTE HANDLERS — BATCH SUMMARY (LEGACY) =====

@app.get("/api/summary")
def summary():
    """Serve the offline batch summary JSON produced by ``analyze.py``.

    HTTP: GET /api/summary
    AUTH: public
    Raises: 404 if ``summary.json`` has not been produced yet.
    """
    return _load_batch("summary.json")
