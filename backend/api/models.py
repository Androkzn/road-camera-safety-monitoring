"""Shared API request/response models for backend routers.

These models provide explicit contracts for high-traffic routes so FastAPI can
validate + document response shapes via OpenAPI.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PerceptionStateModel(BaseModel):
    """Live perception quality summary."""

    state: str
    reason: str | None = None
    samples: int | None = None
    since_sec: float | None = None
    avg_confidence: float | None = None
    luminance: float | None = None
    sharpness: float | None = None

    model_config = ConfigDict(extra="allow")


class SourceStatusModel(BaseModel):
    """Per-source stream status used by live source/status endpoints."""

    id: str
    name: str
    url: str
    stream_type: str
    running: bool
    detection_enabled: bool
    last_error: str | None = None
    frames_read: int
    frames_processed: int
    uptime_sec: float
    playback_pos_sec: float
    playback_duration_sec: float
    started_at: float | None = None
    active_episodes: int
    perception_state: str | None = None
    perception_reason: str | None = None


class SceneContextModel(BaseModel):
    """Scene classifier context attached to events and health endpoints."""

    label: str
    confidence: float | None = None
    speed_proxy_mps: float | None = None
    reason: str | None = None

    model_config = ConfigDict(extra="allow")


class EgoFlowModel(BaseModel):
    """Ego-motion summary attached to events and health endpoints."""

    speed_proxy_mps: float | None = None
    confidence: float | None = None

    model_config = ConfigDict(extra="allow")


class EventModel(BaseModel):
    """Canonical safety event contract shared across list/detail/chat contexts."""

    event_id: str
    source_id: str | None = None
    source_name: str | None = None
    vehicle_id: str | None = None
    road_id: str | None = None
    driver_id: str | None = None
    video_id: str | None = None
    timestamp_sec: float | None = None
    wall_time: str | None = None
    event_type: str
    internal_event_type: str | None = None
    risk_level: str
    peak_risk_level: str | None = None
    risk_demoted: bool | None = None
    risk_frame_counts: dict[str, int] = Field(default_factory=dict)
    frame_count: int | None = None
    confidence: float | None = None
    objects: list[str] = Field(default_factory=list)
    track_ids: list[int] = Field(default_factory=list)
    episode_duration_sec: float | None = None
    camera_orientation: str | None = None
    event_taxonomy: str | None = None
    policy_reason: str | None = None
    ttc_sec: float | None = None
    distance_m: float | None = None
    distance_px: float | None = None
    scene_context: SceneContextModel | None = None
    ego_flow: EgoFlowModel | None = None
    summary: str | None = None
    narration: str | None = None
    thumbnail: str | None = None
    enrichment_skipped: str | None = None
    enrichment: dict[str, Any] | None = None
    perception_state: str | None = None

    model_config = ConfigDict(extra="allow")


class LiveSourcesResponse(BaseModel):
    """Response model for GET /api/live/sources."""

    primary_id: str
    sources: list[SourceStatusModel]


class LiveStatusResponse(BaseModel):
    """Public live status response contract."""

    source: str
    location: str
    running: bool
    event_count: int
    frames_read: int
    frames_processed: int
    uptime_sec: float
    started_at: float | None = None
    llm_configured: bool
    slack_configured: bool
    target_fps: float
    active_episodes: int
    tracker: str
    risk_model: str
    pii_redaction: str
    alpr_mode: str
    perception: PerceptionStateModel
    sources: list[SourceStatusModel]
    primary_id: str


class ChatResponse(BaseModel):
    """Response model for POST /chat."""

    answer: str


class StageTimingStatsModel(BaseModel):
    """Latency stats for one pipeline stage."""

    p50_ms: float | None = None
    p95_ms: float | None = None
    samples: int = 0


class AdminServerHealthModel(BaseModel):
    running: bool
    uptime_sec: float
    started_at: float | None = None
    source: str
    location: str
    target_fps: float


class AdminPipelineHealthModel(BaseModel):
    frames_read: int
    frames_processed: int
    event_count: int
    active_episodes: int
    tracker: str
    risk_model: str
    model: str


class AdminIntegrationsHealthModel(BaseModel):
    llm_configured: bool
    slack_configured: bool
    edge_publisher: bool
    pii_redaction: str
    alpr_mode: str


class AdminHealthResponse(BaseModel):
    """Response model for GET /api/admin/health."""

    server: AdminServerHealthModel
    pipeline: AdminPipelineHealthModel
    integrations: AdminIntegrationsHealthModel
    perception: PerceptionStateModel
    scene: SceneContextModel
    ego: EgoFlowModel
    stage_timings: dict[str, dict[str, StageTimingStatsModel]]
    per_source: dict[str, dict[str, Any]]

