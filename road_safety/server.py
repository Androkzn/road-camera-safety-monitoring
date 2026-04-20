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

from road_safety.logging import setup as setup_logging, get_logger

setup_logging()
log = get_logger(__name__)

from road_safety.config import (
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
    estimate_distances_batch,
    estimate_inter_distance_m,
    estimate_pair_ttc,
    estimate_ttc_sec,
    find_interactions,
    load_model,
    tracks_converging,
    warmup_model,
)
from road_safety.core.stream import (
    StreamReader,
    classify_source,
    display_video_id,
    resolve_hls,
)
from road_safety.core.validator import (
    DiscrepancyComparator,
    SecondaryDetector,
    ValidatorJob,
    ValidatorWorker,
)
from road_safety.core.quality import QualityMonitor
from road_safety.core.context import SceneContextClassifier
from road_safety.core.egomotion import EgoMotionEstimator
from road_safety.core.orientation_policy import classify_event as _orientation_classify
from road_safety.services.llm import chat as llm_chat, enrich_event, llm_configured, narrate_event
from road_safety.services.llm_obs import observer as llm_observer
from road_safety.services.redact import hash_plate, public_thumbnail_name, write_thumbnails
from road_safety.services.agents import AgentExecutor, run_coaching_agent, run_investigation_agent, run_report_agent
from road_safety.services.registry import road_registry
from road_safety.services.drift import ActiveLearningSampler, DriftMonitor, drift_warning_message
from road_safety.services.digest import start_schedulers as start_digest_schedulers
from road_safety.services import video_metadata as video_metadata_service
from road_safety.integrations.slack import (
    aclose as _slack_aclose,
    notify_event as slack_notify,
    slack_configured,
)
from road_safety.integrations.edge_publisher import (
    EdgePublisher,
    aclose as _edge_publisher_aclose,
)
from road_safety.api.feedback import mount as mount_feedback_routes
from road_safety.api.settings import mount as mount_settings_routes
from road_safety.services.impact import ImpactMonitor as SettingsImpactMonitor
from road_safety.services.ops_sampler import OpsSampler
from road_safety.settings_store import STORE as SETTINGS_STORE
from road_safety.compliance import audit
from road_safety.compliance.retention import retention_loop, run_sweep as retention_sweep
from road_safety.services.test_runner import run_state as test_run_state, start_test_run
from road_safety.services.watchdog import Watchdog, WatchdogFinding, _write_finding as _watchdog_write_finding, tail as watchdog_tail, stats as watchdog_stats, delete_findings as watchdog_delete, delete_findings_by_id as watchdog_delete_by_id
from road_safety.security import require_bearer_token


# ===== SECTION: IMPORTS DONE. LOGGING CONFIGURED. =====
# Everything above is pure wiring — bring the dependencies into scope and
# configure structured logging (``setup_logging``) so every module uses the
# same formatter. ``log`` is a module-scoped logger; never ``print``.

# ===== SECTION: STATE (extracted to road_safety.state) =====
# ``Episode``, ``StreamSlot``, ``LiveState``, the process-wide ``state``
# singleton, and the camera-site identity constants live in
# ``road_safety/state.py`` so the perception hot path, routers, and tests
# can import them without circular dependencies on this server module.
# Re-exported here so the existing public API (``from road_safety.server
# import state`` — used by tests) keeps working unchanged.
from road_safety.state import (  # noqa: E402,F401  (re-exports)
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



# ===== SECTION: HELPERS (auth, thumb signing — extracted to road_safety.security) =====
# The auth / signing / SSRF / rate-limit helpers moved to ``road_safety.security``.
# We re-export them here under their original ``_``-prefixed names so existing
# callers (routes, tests) keep working unchanged.
from road_safety.security.auth import (  # noqa: E402,F401
    require_admin as _require_admin,
    require_admin_if_flagged as _require_admin_if_flagged,
)
from road_safety.security.signing import (  # noqa: E402,F401
    MEDIA_TOKEN_TTL_SEC as _MEDIA_TOKEN_TTL_SEC,
    media_token as _media_token,
    require_media_auth as _require_media_auth,
    thumb_token as _thumb_token,
    valid_media_request as _valid_media_request,
    valid_thumb_request as _valid_thumb_request,
)
from road_safety.security.ssrf import (  # noqa: E402,F401
    SSRF_ALLOWLIST_SUFFIXES as _SSRF_ALLOWLIST_SUFFIXES,
    validate_public_url as _validate_public_url,
)
# ===== SECTION: PERCEPTION (extracted to road_safety.perception) =====
# Perception hot path + event emission + slot-lifecycle helpers moved to
# ``road_safety.perception``. Re-exported here under their historical
# ``_``-prefixed names so in-file callers (lifespan, agent executor) and
# tests keep working unchanged.
from road_safety.perception.broadcast import (  # noqa: E402,F401
    broadcast_admin_detections as _broadcast_admin_detections,
    broadcast_perception as _broadcast_perception,
)
from road_safety.perception.emit import (  # noqa: E402,F401
    emit_event as _emit_event,
    find_event as _find_event,
    on_feedback as _on_feedback,
)
from road_safety.perception.episode_emit import (  # noqa: E402,F401
    flush_episode as _flush_episode,
)
from road_safety.perception.on_frame import (  # noqa: E402,F401
    make_on_frame as _make_on_frame,
    on_frame as _on_frame,
)
from road_safety.perception.risk import (  # noqa: E402,F401
    _none_coro,
    classify_with_scene as _classify_with_scene,
    pair_key as _pair_key,
)
from road_safety.perception.score_decay import (  # noqa: E402,F401
    score_decay_loop as _score_decay_loop,
)
from road_safety.perception.slot_control import (  # noqa: E402,F401
    pause_slot as _pause_slot,
    resume_slot as _resume_slot,
    start_slot as _start_slot,
    stop_slot as _stop_slot,
)


from road_safety.security.rate_limit import (  # noqa: E402,F401
    CLIP_BUCKET_CAP as _CLIP_BUCKET_CAP,
    CLIP_BUCKET_REFILL_SEC as _CLIP_BUCKET_REFILL_SEC,
    clip_caller_key as _clip_caller_key,
    clip_rate_limit_check as _clip_rate_limit_check,
)


# ===== SECTION: RENDERING (extracted to road_safety.rendering) =====
# Frame annotation + annotated MP4 clip rendering moved to
# ``road_safety.rendering``. Re-exported here under their historical
# ``_``-prefixed names so in-file callers keep working without further
# renames in this PR.
from road_safety.rendering.frame import render_annotated_frame as _render_annotated_frame  # noqa: E402,F401
from road_safety.rendering.clip import (  # noqa: E402,F401
    CLIP_COLOR_MAP as _CLIP_COLOR_MAP,
    draw_clip_overlay as _draw_clip_overlay,
    get_clip_model as _get_clip_model,
    render_annotated_event_clip as _render_annotated_event_clip,
)


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
        * Warns if camera-site identity is missing.
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

    # Warm up the YOLO model so the first *real* frame doesn't pay the
    # JIT / MPS-kernel / ByteTrack allocation cost (seconds of one-time
    # latency the operator would otherwise see as a false "stream
    # stalled"). ``warmup_model`` is CPU/GPU-heavy so we dispatch it to
    # the default thread-pool executor instead of blocking the event loop.
    # Any failure is non-fatal — the first real inference will surface
    # the underlying issue.
    if YOLO_WARMUP:
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, warmup_model, state.model
            )
        except Exception as exc:
            log.warning("YOLO warmup failed (non-fatal): %s", exc)

    # Point drift monitor at the live in-memory buffer so it reads fresh
    # events rather than the on-disk snapshot.
    state.drift.set_event_source(lambda: list(state.recent_events))

    # ----- Build per-source slots and start each reader -----
    # ``STREAM_SOURCES`` is parsed in ``config.py`` from
    # ``ROAD_STREAM_SOURCES`` (multi-source, primary fallback to legacy
    # ``ROAD_STREAM_SOURCE``). When the env is empty we keep the
    # default-constructed empty primary slot — the API still works,
    # operators can start a stream later via ``/api/live/sources/.../start``.
    if STREAM_SOURCES:
        # Replace the placeholder primary slot with the configured one.
        state.slots.clear()
        for entry in STREAM_SOURCES:
            sid = entry["id"]
            state.slots[sid] = StreamSlot(sid, entry.get("name") or sid, entry["url"])
        # Track human-readable label for the legacy ``/api/live/status``
        # response (single-source clients still see the primary URL).
        primary = state.primary_slot
        state.source_label = primary.original_source

    started = []
    for slot in state.slots.values():
        if not slot.original_source:
            log.warning("slot %s has no source URL; skipping start", slot.source_id)
            continue
        try:
            _start_slot(slot)
            started.append(slot.source_id)
        except Exception as exc:
            log.error("failed to start slot %s: %s", slot.source_id, exc)
            slot.last_error = str(exc)
    if started:
        log.info("started %d stream reader(s): %s", len(started), ", ".join(started))
    else:
        log.warning("no live streams started (no sources or all failed)")

    # Settings Console: warm-reload for TARGET_FPS. The StreamReader captures
    # the fps value at construction time (and bakes it into an ffmpeg command
    # on the yt-dlp path), so a live change only takes effect after the reader
    # is recycled. We restart each active slot on a background thread so the
    # settings-apply HTTP response is not delayed by the stop/join.
    def _on_target_fps_change(before, after) -> None:
        old = float(before.get("TARGET_FPS") or 0.0)
        new = float(after.get("TARGET_FPS") or 0.0)
        if old == new:
            return
        log.info("TARGET_FPS change %.1f -> %.1f — restarting active slots", old, new)

        def _restart_slots() -> None:
            for slot in list(state.slots.values()):
                if slot.reader is None:
                    continue
                try:
                    _stop_slot(slot)
                    _start_slot(slot)
                except Exception as exc:
                    log.warning(
                        "slot %s restart for TARGET_FPS failed: %s", slot.source_id, exc
                    )

        threading.Thread(
            target=_restart_slots, daemon=True, name="target_fps_reload"
        ).start()

    SETTINGS_STORE.register_subscriber_for(
        ["TARGET_FPS"], _on_target_fps_change, name="restart_slots_for_fps"
    )

    # Ops sampler: one periodic thread that records fps / CPU / LLM
    # spend. Safe to start even when no slots are active yet — the
    # sampler will just record zero-fps samples until a reader appears.
    state.ops_sampler.start()

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

    # Background validator — shadow-mode dual-model disagreement detector.
    # Runs a heavier detector on sampled frames + every emitted episode's
    # peak frame; publishes disagreements as watchdog findings. Never
    # blocks the primary perception path.
    validator_task = None
    if VALIDATOR_ENABLED:
        try:
            detector = SecondaryDetector()
            comparator = DiscrepancyComparator(iou_threshold=VALIDATOR_IOU_THRESHOLD)
            state.validator = ValidatorWorker(
                detector=detector,
                comparator=comparator,
                write_finding=_watchdog_write_finding,
                finding_ctor=WatchdogFinding,
                observer_record_skip=(
                    getattr(llm_observer, "record_skip", None)
                ),
                queue_max=VALIDATOR_QUEUE_MAX,
                sample_sec=VALIDATOR_SAMPLE_SEC,
            )
            validator_task = asyncio.create_task(state.validator.run_forever())
            log.info(
                "validator started (backend=%s, sample_sec=%.1f, queue_max=%d)",
                detector.backend,
                VALIDATOR_SAMPLE_SEC,
                VALIDATOR_QUEUE_MAX,
            )
        except Exception as exc:
            log.warning("validator failed to start, continuing without it: %s", exc)
            state.validator = None
    else:
        log.info("validator disabled (ROAD_VALIDATOR_ENABLED=0)")

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
    for slot in state.slots.values():
        if slot.reader:
            try:
                slot.reader.stop()
            except Exception as exc:
                log.warning("slot %s stop failed: %s", slot.source_id, exc)
    try:
        state.ops_sampler.stop()
    except Exception as exc:
        log.warning("ops_sampler stop failed: %s", exc)
    if edge_task is not None:
        edge_task.cancel()
    retention_task.cancel()
    if score_decay_task is not None:
        score_decay_task.cancel()
    if watchdog_task is not None:
        watchdog_task.cancel()
    if validator_task is not None:
        validator_task.cancel()

    # ----- Close shared outbound HTTP clients (BE-D4) -----
    # Both ``integrations/slack.py`` and ``integrations/edge_publisher.py``
    # keep a module-level ``httpx.AsyncClient`` singleton to avoid paying a
    # TCP + TLS handshake per outbound message. Close them *after* the
    # background tasks above are cancelled so any final in-flight send has
    # a chance to complete before we tear the connection pool down.
    for closer in (_slack_aclose, _edge_publisher_aclose):
        try:
            await closer()
        except Exception as exc:
            log.warning(
                "shutdown aclose failed (%s): %s", closer.__module__, exc
            )


# ===== SECTION: FASTAPI APP CONSTRUCTION + STATIC MOUNTS =====

app = FastAPI(title="Live Safety Review", lifespan=lifespan)

THUMBS_DIR.mkdir(parents=True, exist_ok=True)

# ----- Feature routers (extracted in refactor step 4) -----
# Each module exposes a single ``router = APIRouter()`` that carries the
# old ``@app.get(...)`` / ``@app.post(...)`` handlers. Behaviour / paths /
# auth unchanged — this is purely an organisational move.
from road_safety.api.routers import (  # noqa: E402
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


