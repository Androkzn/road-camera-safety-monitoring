"""FastAPI ``lifespan`` hook — startup + shutdown orchestration.

Everything BEFORE ``yield`` runs at startup; everything AFTER runs at
shutdown. This module exists to keep ``server.py`` focused on app
construction / router wiring; the orchestration (model load, slot
start, background task spawning) lives here.

Extracted from ``server.py`` (step 8). Behaviour unchanged — this is
the same function body, moved.
"""

import asyncio
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.config import (
    SCORE_DECAY_INTERVAL_SEC,
    STREAM_SOURCES,
    TARGET_FPS,
    VALIDATOR_ENABLED,
    VALIDATOR_IOU_THRESHOLD,
    VALIDATOR_QUEUE_MAX,
    VALIDATOR_SAMPLE_SEC,
    WATCHDOG_ENABLED,
    WATCHDOG_INTERVAL_SEC,
    YOLO_WARMUP,
)
from backend.compliance.retention import retention_loop
from backend.core.detection import load_model, warmup_model
from backend.core.validator import (
    DiscrepancyComparator,
    SecondaryDetector,
    ValidatorWorker,
)
from backend.integrations.edge_publisher import aclose as _edge_publisher_aclose
from backend.integrations.slack import aclose as _slack_aclose
from backend.logging import get_logger
from backend.perception.score_decay import score_decay_loop
from backend.perception.slot_control import start_slot, stop_slot
from backend.perception.emit import find_event
from backend.services.agents import AgentExecutor
from backend.services.digest import start_schedulers as start_digest_schedulers
from backend.services.llm_obs import observer as llm_observer
from backend.services.test_runner import start_test_run
from backend.services.watchdog import (
    Watchdog,
    WatchdogFinding,
    _write_finding as _watchdog_write_finding,
)
from backend.settings_store import STORE as SETTINGS_STORE
from backend.state import (
    RESOLVED_DRIVER_ID,
    RESOLVED_ROAD_ID,
    RESOLVED_VEHICLE_ID,
    StreamSlot,
    _MISSING_IDENTITY,
    state,
)

log = get_logger(__name__)


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
    model = load_model()
    state.model = model

    # Warm up the YOLO model so the first *real* frame doesn't pay the
    # JIT / MPS-kernel / ByteTrack allocation cost.
    if YOLO_WARMUP:
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, warmup_model, model
            )
        except Exception as exc:
            log.warning("YOLO warmup failed (non-fatal): %s", exc)

    # Point drift monitor at the live in-memory buffer so it reads fresh
    # events rather than the on-disk snapshot.
    state.drift.set_event_source(state.recent_events_snapshot)

    # ----- Build per-source slots and start each reader -----
    if STREAM_SOURCES:
        state.slots.clear()
        for entry in STREAM_SOURCES:
            sid = entry["id"]
            state.slots[sid] = StreamSlot(sid, entry.get("name") or sid, entry["url"])
        primary = state.primary_slot
        state.source_label = primary.original_source

    started = []
    for slot in state.slots.values():
        if not slot.original_source:
            log.warning("slot %s has no source URL; skipping start", slot.source_id)
            continue
        try:
            start_slot(slot)
            started.append(slot.source_id)
        except Exception as exc:
            log.error("failed to start slot %s: %s", slot.source_id, exc)
            slot.last_error = str(exc)
    if started:
        log.info("started %d stream reader(s): %s", len(started), ", ".join(started))
    else:
        log.warning("no live streams started (no sources or all failed)")

    # Settings Console: warm-reload for TARGET_FPS.
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
                    stop_slot(slot)
                    start_slot(slot)
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

    if state.ops_sampler is None:
        raise RuntimeError("ops sampler not configured before startup")
    state.ops_sampler.start()

    start_digest_schedulers(state.loop)
    log.info("digest schedulers started")

    edge_task = None
    if state.edge_publisher.enabled():
        edge_task = asyncio.create_task(state.edge_publisher.run_forever())
        log.info("edge publisher started")
    else:
        log.info("edge publisher disabled (ROAD_CLOUD_ENDPOINT / _HMAC_SECRET unset)")

    retention_task = asyncio.create_task(retention_loop())
    log.info("retention policy loop started")
    score_decay_task = None
    if SCORE_DECAY_INTERVAL_SEC > 0:
        score_decay_task = asyncio.create_task(
            score_decay_loop(SCORE_DECAY_INTERVAL_SEC)
        )
        log.info("score decay loop started (interval=%ds)", SCORE_DECAY_INTERVAL_SEC)

    state.agent_executor = AgentExecutor(
        event_lookup=find_event,
        events_source=state.recent_events_snapshot,
        drift_monitor=state.drift,
    )
    log.info("agent executor ready (coaching, investigation, report)")

    start_test_run()
    log.info("test suite started in background")

    # Background validator — shadow-mode dual-model disagreement detector.
    validator_task = None
    if VALIDATOR_ENABLED:
        try:
            detector = SecondaryDetector()
            comparator = DiscrepancyComparator(iou_threshold=VALIDATOR_IOU_THRESHOLD)
            validator = ValidatorWorker(
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
            state.validator = validator
            validator_task = asyncio.create_task(validator.run_forever())
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
    watchdog_task = None
    if WATCHDOG_ENABLED:
        def _collect_snapshot() -> dict:
            """Build the point-in-time health snapshot for the watchdog."""
            q = state.quality.state()
            ctx = state.last_scene_ctx
            ego = state.last_ego_flow
            reader = state.reader
            drift_report = state.drift.compute().as_dict()
            llm_stats = llm_observer.stats(window_sec=300)
            recent_events = state.recent_events_snapshot(limit=25)
            unknown_event_types = sum(
                1 for evt in recent_events
                if not evt.get("event_type") or evt.get("event_type") == "unknown"
            )
            unknown_risk_levels = sum(
                1 for evt in recent_events
                if not evt.get("risk_level") or evt.get("risk_level") == "unknown"
            )
            recent_confidences: list[float] = []
            for evt in recent_events:
                conf = evt.get("confidence")
                if isinstance(conf, (int, float)):
                    recent_confidences.append(float(conf))
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
                    "event_count": len(state.recent_events_snapshot()),
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
    yield

    # ----- Shutdown: cancel every background task we started -----
    for slot in state.slots.values():
        if slot.reader:
            try:
                slot.reader.stop()
            except Exception as exc:
                log.warning("slot %s stop failed: %s", slot.source_id, exc)
    try:
        if state.ops_sampler is not None:
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
    for closer in (_slack_aclose, _edge_publisher_aclose):
        try:
            await closer()
        except Exception as exc:
            log.warning(
                "shutdown aclose failed (%s): %s", closer.__module__, exc
            )
