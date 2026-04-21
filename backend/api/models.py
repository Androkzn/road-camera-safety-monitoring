"""Shared API request/response models for backend routers.

Every class in this file is a ``pydantic.BaseModel`` — a schema declared
as a Python class whose fields are type-annotated attributes. FastAPI uses
these models two ways:

* On *input* (request body): it reads the JSON body, validates it against
  the model, and hands the handler a fully-typed object.
* On *output* (``response_model=...`` on a route): it filters the returned
  dict through the model, producing a stable OpenAPI schema + validated
  JSON response.

In short: these classes are the "contracts" the HTTP layer speaks.

**This file is the source of truth for cross-process types.** The TypeScript
equivalents in ``frontend/src/shared/types/generated.ts`` are produced from
these models by ``scripts/generate_ts_types.py``; do not hand-edit the
generated file. Add a new field here first, regenerate, then use it on the
frontend.
"""

from __future__ import annotations

from typing import Any, Literal

# Pydantic — data-validation / parsing library. ``BaseModel`` is the
# base class every schema extends. ``ConfigDict`` tunes model behaviour
# (here we use ``extra="allow"`` to keep unknown fields rather than
# rejecting them — convenient while the shape is still evolving).
# ``Field`` attaches extra metadata (defaults, constraints) to a field.
from pydantic import BaseModel, ConfigDict, Field

# ``RiskLevel`` / ``StreamType`` are closed string enums — ``Literal``
# narrows the type so the generated TypeScript becomes a union of string
# literals, not ``string``. This is the kind of contract mismatch that
# used to bite us when FE + BE drifted (e.g. FE accepted "critical" but
# BE never emitted it).
RiskLevel = Literal["high", "medium", "low"]
StreamType = Literal["dashcam_file", "live_yt", "live_hls", "webcam", "unknown"]


class PerceptionStateModel(BaseModel):
    """Live perception-quality summary.

    Describes *how well* the camera is seeing right now: luminance,
    sharpness, running average of detection confidence, and a short
    human-readable reason string. Attached to live/status and admin
    health responses.
    """

    state: str
    reason: str | None = None
    samples: int | None = None
    since_sec: float | None = None
    avg_confidence: float | None = None
    luminance: float | None = None
    sharpness: float | None = None

    # ``extra="allow"`` — don't reject unknown keys. The perception
    # subsystem occasionally adds a new field; clients shouldn't break.
    model_config = ConfigDict(extra="allow")


class PerceptionStateMessage(BaseModel):
    """SSE message envelope for a perception-state update.

    The ``/stream/events`` SSE channel multiplexes two payload types:
    ``SafetyEvent`` (a near-miss) and this one (a perception-quality
    heartbeat). The frontend discriminates on ``_meta == "perception_state"``
    — so we model it here as a ``Literal`` field to keep that contract
    visible in the generated TS instead of living as an undeclared
    string on the event object.
    """

    # ``Field(alias="_meta")`` exposes the field over JSON as ``_meta``
    # while keeping the Python attribute name pep8-clean. Pydantic
    # populates by alias when parsing an incoming dict; the
    # ``populate_by_name=True`` config also lets callers construct the
    # model with the Python name.
    meta: Literal["perception_state"] = Field(alias="_meta")
    state: str
    reason: str | None = None
    samples: int | None = None
    since_sec: float | None = None
    avg_confidence: float | None = None
    luminance: float | None = None
    sharpness: float | None = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class SourceStatusModel(BaseModel):
    """Per-source stream status used by live source/status endpoints.

    One of these is returned per configured camera/video-file slot —
    frame counters, playback position, detection toggle, last error, etc.
    """

    id: str
    name: str
    url: str
    stream_type: StreamType
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


class SceneThresholdsModel(BaseModel):
    """Adaptive risk thresholds rescaled per scene label.

    Emitted alongside the scene context by ``/api/live/scene`` so the UI
    can surface *why* the current near-miss gates are where they are
    (urban thresholds are tighter than highway, parking is tighter than
    urban). Every threshold value is in its natural unit — seconds for
    TTC, metres for distance — so the UI can render them directly.
    """

    ttc_high_sec: float
    ttc_med_sec: float
    dist_high_m: float
    dist_med_m: float


class SceneContextModel(BaseModel):
    """Scene classifier context attached to events and health endpoints.

    Carries the scene label (urban / highway / parking), its confidence,
    and an ego-speed proxy derived from optical flow. The optional
    ``pedestrian_rate_per_min`` / ``vehicle_rate_per_min`` / ``thresholds``
    fields are populated by ``/api/live/scene`` only — on emitted events
    we ship the trimmed 4-field subset.
    """

    label: str
    confidence: float | None = None
    speed_proxy_mps: float | None = None
    pedestrian_rate_per_min: float | None = None
    vehicle_rate_per_min: float | None = None
    reason: str | None = None
    thresholds: SceneThresholdsModel | None = None

    model_config = ConfigDict(extra="allow")


class EgoFlowModel(BaseModel):
    """Ego-motion summary attached to events and health endpoints.

    Ego-motion = "how fast is our own camera platform moving?" — used to
    distinguish a rapidly-approaching obstacle from the scene simply
    panning past the camera.
    """

    speed_proxy_mps: float | None = None
    confidence: float | None = None

    model_config = ConfigDict(extra="allow")


class EnrichmentModel(BaseModel):
    """LLM / ALPR post-processing output attached to a safety event.

    SECURITY INVARIANT: ``plate_text`` / ``plate_state`` are deliberately
    NOT fields on this model. The backend strips them at ingest in
    ``enrich_event()``; only the hashed plate ever reaches the frontend.
    Adding a plate-text field here would defeat the in-memory redaction
    and let raw plates land in every SSE subscriber's buffer.
    """

    plate_hash: str | None = None
    readability: str | None = None
    vehicle_color: str | None = None
    vehicle_type: str | None = None

    model_config = ConfigDict(extra="allow")


class EventModel(BaseModel):
    """Canonical safety-event contract shared across list/detail/chat contexts.

    A safety event is what the perception pipeline emits when a near-miss
    (or similar) is detected. Every list-of-events endpoint, event-detail
    endpoint, and the copilot chat backend all agree on this shape.
    """

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
    risk_level: RiskLevel
    peak_risk_level: RiskLevel | None = None
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
    enrichment: EnrichmentModel | None = None
    perception_state: str | None = None

    model_config = ConfigDict(extra="allow")


class DetectionObjectModel(BaseModel):
    """One detection within a per-frame snapshot.

    Flat shape because the admin overlay draws dozens per frame and any
    nested field access shows up in the profile. ``distance_axis`` is the
    semantic axis of ``distance_m`` — forward/rear cameras report
    ``"range"`` (longitudinal distance; TTC is meaningful); side cameras
    report ``"lateral"`` (sideways distance; TTC is not).
    """

    cls: str
    conf: float
    track_id: int | None = None
    # Pixel-space bounding box (x1, y1, x2, y2). Declared as a fixed-
    # length tuple (not ``list[float]``) so the generated TypeScript
    # emits a 4-element tuple type ``[number, number, number, number]``
    # — the FE's overlay renderer unpacks it with ``o.bbox[2]`` and
    # ``noUncheckedIndexedAccess`` would otherwise report the result as
    # ``number | undefined`` for an unbounded array. On the wire this
    # still serializes to a JSON array of four numbers.
    bbox: tuple[float, float, float, float]
    distance_m: float | None = None
    distance_axis: Literal["range", "lateral"] | None = None

    model_config = ConfigDict(extra="allow")


class DetectionSnapshotModel(BaseModel):
    """One per-frame snapshot broadcast over the admin SSE stream.

    Produced by the perception thread inside ``on_frame.py``; consumed by
    the admin grid's overlay renderer. ``playback_pos_sec`` /
    ``playback_duration_sec`` are zero for live feeds and populated for
    looped local files so the map overlay marker stays locked to the
    frame the user is actually watching.
    """

    ts: float
    source_id: str | None = None
    source_name: str | None = None
    detections: int
    persons: int
    vehicles: int
    interactions: int
    objects: list[DetectionObjectModel] = Field(default_factory=list)
    playback_pos_sec: float | None = None
    playback_duration_sec: float | None = None

    model_config = ConfigDict(extra="allow")


class DriftReportModel(BaseModel):
    """Rolling precision report from the operator-feedback drift monitor.

    Tracks whether the ratio of labelled true-vs-false positives is
    drifting — a drop in precision is often the first signal that a
    scene or lens change has invalidated the current thresholds.
    """

    window_size: int
    true_positives: int
    false_positives: int
    precision: float | None = None
    trend: str | None = None
    alert_triggered: bool | None = None

    model_config = ConfigDict(extra="allow")


class LiveSourcesResponse(BaseModel):
    """Response model for GET /api/live/sources.

    Wraps the full source list with a ``primary_id`` pointer so the UI
    knows which slot to highlight as "main".
    """

    primary_id: str
    sources: list[SourceStatusModel]


class LiveStatusResponse(BaseModel):
    """Public live status response contract.

    Dense summary used by the operator UI header: is the pipeline
    running? how many frames? which integrations configured? which
    sources live? Returned by GET /api/live/status.
    """

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
    """Response model for POST /chat.

    Single field: the LLM-generated answer string. Used by the copilot
    Q&A endpoint.
    """

    answer: str


class StageTimingStatsModel(BaseModel):
    """Latency stats for one pipeline stage.

    p50 = median, p95 = 95th-percentile, samples = how many datapoints
    the percentiles are computed over. ``None`` when no samples yet.
    """

    p50_ms: float | None = None
    p95_ms: float | None = None
    samples: int = 0


class AdminServerHealthModel(BaseModel):
    """Server process health: uptime, started-at, primary source."""

    running: bool
    uptime_sec: float
    started_at: float | None = None
    source: str
    location: str
    target_fps: float


class AdminPipelineHealthModel(BaseModel):
    """Perception pipeline counters: frames, events, tracker + risk-model ids."""

    frames_read: int
    frames_processed: int
    event_count: int
    active_episodes: int
    tracker: str
    risk_model: str
    model: str


class AdminIntegrationsHealthModel(BaseModel):
    """Which optional integrations (LLM, Slack, cloud) are configured + enabled."""

    llm_configured: bool
    slack_configured: bool
    edge_publisher: bool
    pii_redaction: str
    alpr_mode: str


class AdminHealthResponse(BaseModel):
    """Response model for GET /api/admin/health.

    Composite of every sub-health model above, plus a ``per_source`` map
    so multi-camera dashboards can render per-slot tiles.
    """

    server: AdminServerHealthModel
    pipeline: AdminPipelineHealthModel
    integrations: AdminIntegrationsHealthModel
    perception: PerceptionStateModel
    scene: SceneContextModel
    ego: EgoFlowModel
    stage_timings: dict[str, dict[str, StageTimingStatsModel]]
    per_source: dict[str, dict[str, Any]]


# =============================================================================
# Watchdog
# =============================================================================


class WatchdogEvidenceModel(BaseModel):
    """One row of evidence attached to a watchdog finding.

    Roughly mirrors a log-line-with-threshold: label ("frame drop rate"),
    value ("12%"), optional threshold ("<5%"), and optional status tag
    ("failing" / "warning"). The watchdog groups these under each finding
    so the UI can render a compact evidence table rather than a prose blob.
    """

    label: str
    value: str
    threshold: str | None = None
    status: str | None = None


class WatchdogFindingModel(BaseModel):
    """One emitted watchdog finding — operator-facing incident summary.

    The watchdog produces a queue of fingerprinted incidents (dedup key is
    ``fingerprint``). Each finding carries its severity, category,
    human-readable title/detail, suggested next step, and enough context
    (evidence, investigation_steps, debug_commands) for an on-call to act
    without round-tripping through the source code.
    """

    severity: Literal["error", "warning", "info"]
    category: str
    title: str
    detail: str
    suggestion: str
    impact: str | None = None
    likely_cause: str | None = None
    owner: str | None = None
    runbook: str | None = None
    fingerprint: str | None = None
    source: Literal["rule", "ai"] | None = None
    cause_confidence: Literal["observed", "inferred"] | None = None
    priority_score: float | None = None
    evidence: list[WatchdogEvidenceModel] = Field(default_factory=list)
    investigation_steps: list[str] = Field(default_factory=list)
    debug_commands: list[str] = Field(default_factory=list)
    ts: str
    snapshot_id: str

    model_config = ConfigDict(extra="allow")


class WatchdogTopIncidentModel(BaseModel):
    """Top-N incident summary embedded in the watchdog status payload."""

    fingerprint: str
    severity: str
    category: str
    title: str
    owner: str
    count: int
    first_seen_ts: str
    last_seen_ts: str
    latest: WatchdogFindingModel


class WatchdogStatusModel(BaseModel):
    """Response model for GET /api/watchdog/status.

    Counters + grouped summary so the frontend can render the "incident
    queue" overview (as opposed to a log-tail of every finding ever).
    """

    enabled: bool
    interval_sec: float
    last_run: float
    last_run_ago_sec: float | None = None
    run_count: int
    total_findings_emitted: int
    total_findings: int
    unique_incidents: int | None = None
    repeating_incidents: int | None = None
    by_severity: dict[str, int] = Field(default_factory=dict)
    by_category: dict[str, int] = Field(default_factory=dict)
    top_incidents: list[WatchdogTopIncidentModel] = Field(default_factory=list)

    model_config = ConfigDict(extra="allow")


# =============================================================================
# Test runner
# =============================================================================


class TestResultModel(BaseModel):
    """One pytest node result surfaced through the operator UI."""

    name: str
    node_id: str
    file: str
    outcome: Literal["passed", "failed", "error", "skipped"]
    duration_ms: float
    message: str | None = None


class TestStatusModel(BaseModel):
    """Response model for GET /api/tests/status.

    Rolled-up counts + the full per-node result list. ``status`` drives
    the run/stop button state in the operator UI.
    """

    status: Literal["idle", "running", "passed", "failed"]
    total: int
    passed: int
    failed: int
    skipped: int
    progress: float
    elapsed_sec: float
    results: list[TestResultModel] = Field(default_factory=list)

    model_config = ConfigDict(extra="allow")


# =============================================================================
# Registry of exported models
# =============================================================================
#
# ``EXPORTED_MODELS`` is read by ``scripts/generate_ts_types.py`` to pick
# the set of BaseModel subclasses to emit into
# ``frontend/src/shared/types/generated.ts``. Adding a new model here is
# the only wiring needed for the codegen to pick it up — keep it
# alphabetical for easy diffing.

EXPORTED_MODELS: tuple[type[BaseModel], ...] = (
    AdminHealthResponse,
    AdminIntegrationsHealthModel,
    AdminPipelineHealthModel,
    AdminServerHealthModel,
    ChatResponse,
    DetectionObjectModel,
    DetectionSnapshotModel,
    DriftReportModel,
    EgoFlowModel,
    EnrichmentModel,
    EventModel,
    LiveSourcesResponse,
    LiveStatusResponse,
    PerceptionStateMessage,
    PerceptionStateModel,
    SceneContextModel,
    SceneThresholdsModel,
    SourceStatusModel,
    StageTimingStatsModel,
    TestResultModel,
    TestStatusModel,
    WatchdogEvidenceModel,
    WatchdogFindingModel,
    WatchdogStatusModel,
    WatchdogTopIncidentModel,
)
