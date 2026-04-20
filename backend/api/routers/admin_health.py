"""Admin dashboard health snapshot."""

from pathlib import Path

from fastapi import APIRouter

from backend.api.models import AdminHealthResponse
from backend.config import (
    ALPR_MODE,
    DSAR_TOKEN,
    LOCATION,
    MODEL_PATH,
    PUBLIC_THUMBS_REQUIRE_TOKEN,
    TARGET_FPS,
)
from backend.integrations.slack import slack_configured
from backend.services.llm import llm_configured
from backend.state import state

router = APIRouter()


@router.get("/api/admin/health", response_model=AdminHealthResponse)
def admin_health():
    """Comprehensive health snapshot for the admin dashboard.

    HTTP: GET /api/admin/health
    AUTH: public (dashboard metadata only)
    Returns: nested dict with server / pipeline / integrations /
        perception / scene / ego sub-objects — designed for direct
        rendering in the admin health panel.

    BE-D8: aggregates + primary-slot fields come from ``state.snapshot()``
    so the frame counts / active_episodes / running fields are all
    consistent with each other (no torn reads on a slot restart).

    BE-D1 Option B: the top-level ``perception`` / ``scene`` / ``ego``
    sub-objects remain primary-biased for backwards compatibility; a
    new ``per_source`` map exposes the full perception metadata per
    slot so FE can migrate incrementally.
    """
    snap = state.snapshot()
    primary_slot = state.slots.get(snap.primary_source_id) or state.primary_slot
    q = primary_slot.quality.state()
    ctx = primary_slot.last_scene_ctx
    ego = primary_slot.last_ego_flow
    primary_status = next(
        (s for s in snap.sources if s.get("id") == snap.primary_source_id),
        None,
    )
    # BE-D5.A: per-stage p50/p95 latency per source. Keyed by source_id so
    # operators can spot a slow camera without guessing from aggregate
    # frame counts. Empty dict when no slots exist (tests, cold start).
    stage_timings = {
        sid: slot.stage_stats() for sid, slot in state.slots.items()
    }
    # BE-D1 Option B: per-source perception / scene / ego + stage_timings,
    # so multi-camera deployments can show the correct metadata for each
    # tile. Top-level fields above remain as primary-proxy aliases.
    per_source: dict[str, dict] = {}
    for sid, slot in state.slots.items():
        slot_ctx = slot.last_scene_ctx
        slot_ego = slot.last_ego_flow
        per_source[sid] = {
            "quality": slot.quality.state(),
            "scene": (
                {
                    "label": slot_ctx.label,
                    "confidence": round(slot_ctx.confidence, 2),
                    "speed_proxy_mps": (
                        round(slot_ctx.speed_proxy_mps, 2)
                        if slot_ctx.speed_proxy_mps is not None
                        else None
                    ),
                    "reason": slot_ctx.reason,
                }
                if slot_ctx is not None
                else {
                    "label": "unknown",
                    "confidence": None,
                    "speed_proxy_mps": None,
                    "reason": "not yet observed",
                }
            ),
            "ego": (
                {
                    "speed_proxy_mps": round(slot_ego.speed_proxy_mps, 2),
                    "confidence": round(slot_ego.confidence, 2),
                }
                if slot_ego is not None
                else {"speed_proxy_mps": None, "confidence": None}
            ),
            "stage_timings": slot.stage_stats(),
        }
    return {
        "server": {
            "running": bool(primary_status.get("running")) if primary_status else False,
            "uptime_sec": primary_status.get("uptime_sec", 0.0) if primary_status else 0.0,
            "started_at": primary_status.get("started_at") if primary_status else None,
            "source": state.source_label,
            "location": LOCATION,
            "target_fps": TARGET_FPS,
        },
        "pipeline": {
            "frames_read": snap.frames_read_total,
            "frames_processed": snap.frames_processed_total,
            "event_count": snap.recent_events_count,
            "active_episodes": snap.episodes_total,
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
        "stage_timings": stage_timings,
        "per_source": per_source,
    }
