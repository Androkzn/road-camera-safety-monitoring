"""Live safety review API — the "brain" of the road-camera safety monitoring system.

Pulls a live stream from a fixed traffic camera (YouTube live stream of an
intersection, HLS feed, RTSP camera, or a local MP4 used for testing), runs
YOLO at 2 fps in a background thread, emits typed safety events over
Server-Sent Events with an LLM-generated one-line narration, and exposes a
RAG-backed copilot endpoint over a tiny statute/policy corpus.

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
import ipaddress
import json
import socket
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import cv2
from dataclasses import dataclass
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend.logging import setup as setup_logging, get_logger

setup_logging()
log = get_logger(__name__)

from backend.config import (
    ALPR_MODE,
    DATA_DIR,
    DEFAULT_STREAM_SOURCE as DEFAULT_SOURCE,
    STREAM_SOURCES,
    ADMIN_TOKEN,
    DSAR_TOKEN,
    DRIVER_ID,
    EPISODE_IDLE_FLUSH_SEC,
    LOCATION,
    ROAD_ID,
    MAX_RECENT_EVENTS,
    MODEL_PATH,
    PAIR_COOLDOWN_SEC,
    PER_SOURCE_METADATA,
    PUBLIC_THUMBS_REQUIRE_TOKEN,
    REQUIRE_AUTH,
    SCORE_DECAY_INTERVAL_SEC,
    SSE_REPLAY_COUNT,
    VALIDATOR_ENABLED,
    VALIDATOR_IOU_THRESHOLD,
    VALIDATOR_QUEUE_MAX,
    VALIDATOR_SAMPLE_SEC,
    YOLO_WARMUP,
    camera_calibration_for,
    WATCHDOG_ENABLED,
    WATCHDOG_INTERVAL_SEC,
    STATIC_DIR,
    TARGET_FPS,
    THUMB_SIGNING_SECRET,
    THUMBS_DIR,
    VEHICLE_ID,
)
from backend.core.detection import (
    LOW_SPEED_FLOOR_MPS,
    VEHICLE_CLASSES,
    VEHICLE_INTER_DISTANCE_GATE_M,
    TrackHistory,
    bbox_edge_distance,
    build_event_summary,
    classify_risk,
    detect_frame,
    estimate_distance_m,
    estimate_distances_batch,
    estimate_inter_distance_m,
    estimate_pair_ttc,
    estimate_ttc_sec,
    find_interactions,
    load_model,
    tracks_converging,
    warmup_model,
)
from backend.core.stream import (
    StreamReader,
    classify_source,
    display_video_id,
    resolve_hls,
)
from backend.core.validator import (
    DiscrepancyComparator,
    SecondaryDetector,
    ValidatorJob,
    ValidatorWorker,
)
from backend.core.quality import QualityMonitor
from backend.core.context import SceneContextClassifier
from backend.core.egomotion import EgoMotionEstimator
from backend.core.orientation_policy import classify_event as _orientation_classify
from backend.services.llm import chat as llm_chat, enrich_event, llm_configured, narrate_event
from backend.services.llm_obs import observer as llm_observer
from backend.services.redact import hash_plate, public_thumbnail_name, write_thumbnails
from backend.services.agents import AgentExecutor, run_coaching_agent, run_investigation_agent, run_report_agent
from backend.services.registry import road_registry
from backend.services.drift import ActiveLearningSampler, DriftMonitor, drift_warning_message
from backend.services.digest import start_schedulers as start_digest_schedulers
from backend.services import video_metadata as video_metadata_service
from backend.integrations.slack import (
    aclose as _slack_aclose,
    notify_event as slack_notify,
    slack_configured,
)
from backend.integrations.edge_publisher import (
    EdgePublisher,
    aclose as _edge_publisher_aclose,
)
from backend.api.feedback import mount as mount_feedback_routes
from backend.api.settings import mount as mount_settings_routes
from backend.services.impact import ImpactMonitor as SettingsImpactMonitor
from backend.services.ops_sampler import OpsSampler
from backend.settings_store import STORE as SETTINGS_STORE
from backend.compliance import audit
from backend.compliance.retention import retention_loop, run_sweep as retention_sweep
from backend.services.test_runner import run_state as test_run_state, start_test_run
from backend.services.watchdog import Watchdog, WatchdogFinding, _write_finding as _watchdog_write_finding, tail as watchdog_tail, stats as watchdog_stats, delete_findings as watchdog_delete, delete_findings_by_id as watchdog_delete_by_id
from backend.security import require_bearer_token


# ===== SECTION: IMPORTS DONE. LOGGING CONFIGURED. =====
# Everything above is pure wiring — bring the dependencies into scope and
# configure structured logging (``setup_logging``) so every module uses the
# same formatter. ``log`` is a module-scoped logger; never ``print``.

# ===== SECTION: STATE (extracted to backend.state) =====
# ``Episode``, ``StreamSlot``, ``LiveState``, the process-wide ``state``
# singleton, and the camera-site identity constants live in
# ``backend/state.py`` so the perception hot path, routers, and tests
# can import them without circular dependencies on this server module.
# Re-exported here so the existing public API (``from backend.server
# import state`` — used by tests) keeps working unchanged.
from backend.state import (  # noqa: E402,F401  (re-exports)
    MIN_HIGH_RISK_EPISODE_SEC,
    MIN_HIGH_RISK_FRAMES,
    MIN_MEDIUM_RISK_FRAMES,
    Episode,
    LiveState,
    LiveStateSnapshot,
    RESOLVED_DRIVER_ID,
    RESOLVED_ROAD_ID,
    RESOLVED_VEHICLE_ID,
    StreamSlot,
    _MISSING_IDENTITY,
    _resolve_identity,
    state,
)



# ===== SECTION: HELPERS (auth, thumb signing — extracted to backend.security) =====
# The auth / signing / SSRF / rate-limit helpers moved to ``backend.security``.
# We re-export them here under their original ``_``-prefixed names so existing
# callers (routes, tests) keep working unchanged.
from backend.security.auth import (  # noqa: E402,F401
    require_admin as _require_admin,
    require_admin_if_flagged as _require_admin_if_flagged,
)
from backend.security.signing import (  # noqa: E402,F401
    MEDIA_TOKEN_TTL_SEC as _MEDIA_TOKEN_TTL_SEC,
    media_token as _media_token,
    require_media_auth as _require_media_auth,
    thumb_token as _thumb_token,
    valid_media_request as _valid_media_request,
    valid_thumb_request as _valid_thumb_request,
)
from backend.security.ssrf import (  # noqa: E402,F401
    SSRF_ALLOWLIST_SUFFIXES as _SSRF_ALLOWLIST_SUFFIXES,
    validate_public_url as _validate_public_url,
)
# ===== SECTION: PERCEPTION (extracted to backend.perception) =====
# Perception hot path + event emission + slot-lifecycle helpers moved to
# ``backend.perception``. Re-exported here under their historical
# ``_``-prefixed names so in-file callers (lifespan, agent executor) and
# tests keep working unchanged.
from backend.perception.broadcast import (  # noqa: E402,F401
    broadcast_admin_detections as _broadcast_admin_detections,
    broadcast_perception as _broadcast_perception,
)
from backend.perception.emit import (  # noqa: E402,F401
    emit_event as _emit_event,
    find_event as _find_event,
    on_feedback as _on_feedback,
)
from backend.perception.episode_emit import (  # noqa: E402,F401
    flush_episode as _flush_episode,
)
from backend.perception.on_frame import (  # noqa: E402,F401
    make_on_frame as _make_on_frame,
    on_frame as _on_frame,
)
from backend.perception.risk import (  # noqa: E402,F401
    _none_coro,
    classify_with_scene as _classify_with_scene,
    pair_key as _pair_key,
)
from backend.perception.score_decay import (  # noqa: E402,F401
    score_decay_loop as _score_decay_loop,
)
from backend.perception.slot_control import (  # noqa: E402,F401
    pause_slot as _pause_slot,
    resume_slot as _resume_slot,
    start_slot as _start_slot,
    stop_slot as _stop_slot,
)


from backend.security.rate_limit import (  # noqa: E402,F401
    CLIP_BUCKET_CAP as _CLIP_BUCKET_CAP,
    CLIP_BUCKET_REFILL_SEC as _CLIP_BUCKET_REFILL_SEC,
    clip_caller_key as _clip_caller_key,
    clip_rate_limit_check as _clip_rate_limit_check,
)


# ===== SECTION: RENDERING (extracted to backend.rendering) =====
# Frame annotation + annotated MP4 clip rendering moved to
# ``backend.rendering``. Re-exported here under their historical
# ``_``-prefixed names so in-file callers keep working without further
# renames in this PR.
from backend.rendering.frame import render_annotated_frame as _render_annotated_frame  # noqa: E402,F401
from backend.rendering.clip import (  # noqa: E402,F401
    CLIP_COLOR_MAP as _CLIP_COLOR_MAP,
    draw_clip_overlay as _draw_clip_overlay,
    get_clip_model as _get_clip_model,
    render_annotated_event_clip as _render_annotated_event_clip,
)


# ===== SECTION: LIFESPAN (extracted to backend.startup) =====
# The lifespan body (YOLO load, stream-reader start, background-task
# spawn, shutdown cancel) lives in ``backend.startup`` so this file
# stays focused on app construction + router wiring.
from backend.startup import lifespan  # noqa: E402


# ===== SECTION: FASTAPI APP CONSTRUCTION + STATIC MOUNTS =====

app = FastAPI(title="Live Safety Review", lifespan=lifespan)

THUMBS_DIR.mkdir(parents=True, exist_ok=True)

# ----- Feature routers (extracted in refactor step 4) -----
# Each module exposes a single ``router = APIRouter()`` that carries the
# old ``@app.get(...)`` / ``@app.post(...)`` handlers. Behaviour / paths /
# auth unchanged — this is purely an organisational move.
from backend.api.routers import (  # noqa: E402
    active_learning as _router_active_learning,
    admin_health as _router_admin_health,
    admin_video as _router_admin_video,
    agents as _router_agents,
    audit as _router_audit,
    live as _router_live,
    llm_obs as _router_llm_obs,
    retention as _router_retention,
    road as _router_road,
    sources as _router_sources,
    spa as _router_spa,
    sse as _router_sse,
    tests as _router_tests,
    thumbnails as _router_thumbnails,
    watchdog as _router_watchdog,
)

for _r in (
    _router_audit,
    _router_retention,
    _router_llm_obs,
    _router_road,
    _router_agents,
    _router_tests,
    _router_active_learning,
    _router_spa,
    _router_thumbnails,
    _router_sse,
    _router_admin_health,
    _router_admin_video,
    _router_live,
    _router_watchdog,
    _router_sources,
):
    app.include_router(_r.router)

app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

mount_feedback_routes(app, on_feedback=_on_feedback, event_lookup=_find_event)


# ===== SECTION: SETTINGS CONSOLE ROUTES =====
# The Settings Console (see docs/improvements/settings-console-plan.md) lets
# operators tune backend parameters at runtime, save templates, and inspect
# baseline-vs-after impact with deterministic comparability gates and an
# optional advisory LLM narrative. The router is admin-bearer only; the
# impact SSE stream uses a single-use ticket exchange to avoid leaking the
# long-lived bearer through query strings / access logs.
# Ops sampler: periodic snapshot of actual fps, CPU, memory, and LLM
# cost/latency/tokens. The Settings Console uses its window_stats() to
# populate the operational-metric deltas in the Impact report so an
# operator can see whether a change made the pipeline cheaper / faster /
# heavier, not just whether it shifted the event-rate distribution.
def _aggregate_frames() -> tuple[int, int]:
    """Sum ``frames_read`` / ``frames_processed`` across all active slots.

    Returning a single pair keeps the sampler agnostic to the
    multi-source slot model — it just sees "how many frames did the
    pipeline ingest + process since start".
    """
    total_read = 0
    total_proc = 0
    for slot in state.slots.values():
        r = slot.reader
        if r is not None:
            total_read += int(getattr(r, "frames_read", 0) or 0)
            total_proc += int(getattr(r, "frames_processed", 0) or 0)
    return total_read, total_proc


state.ops_sampler = OpsSampler(
    frames_source=_aggregate_frames,
    llm_stats_fn=llm_observer.stats,
)

state.settings_impact = SettingsImpactMonitor(
    events_source=lambda: list(state.recent_events),
    ops_stats_fn=state.ops_sampler.window_stats,
)
state.settings_impact_subscribers: list[asyncio.Queue] = []
mount_settings_routes(
    app,
    impact_monitor=state.settings_impact,
    impact_subscribers=state.settings_impact_subscribers,
)


