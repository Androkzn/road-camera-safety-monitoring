"""Pydantic wire-contract models — single source of truth for API payloads.

Every request body and response shape the frontend depends on lives here as
a Pydantic model. `scripts/generate_ts_types.py` walks the `EXPORTED_MODELS`
tuple in this file, emits JSON Schema for each model, and generates
`frontend/src/shared/types/generated.ts`. That TS file is then imported by
every feature — so a rename here triggers a TypeScript error there.

Python primer:
 - Pydantic `BaseModel` is like a typed dataclass that ALSO validates
   incoming JSON at runtime. When FastAPI sees `response_model=MyModel`
   it coerces the handler's return value through this validator.
 - `Literal["a", "b"]` types become TS string-literal unions in generated.ts.
 - `tuple[float, float, float, float]` becomes a TS 4-tuple.
 - `field: X | None = None` becomes `field?: X` on the TS side.

UI connection
-------------
Page: ALL pages (every page imports types from shared/types/generated.ts,
which was generated from this file).
UI element: Every API-backed list, form, card, and dialog in the SPA is
typed by a model defined here. For example, EventCard props come from
SafetyEvent; the Settings apply form shape comes from ApplyRequestModel.
Backend route(s): Models here are the `response_model=` and request-body
annotations on handlers across backend/api/routers/*.
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
    """Live perception-quality summary (how well the camera is seeing right now).

    Carries luminance (how bright the image is), sharpness (how in-focus),
    a running average of detection confidence, and a short human-readable
    ``reason`` string.

    Routes: embedded in GET /api/live/status and GET /api/admin/health.
    Drives the "perception health" dot on the operator UI header.
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

    SSE = Server-Sent Events: a long-lived HTTP stream the server pushes
    JSON lines down. The ``/stream/events`` SSE channel multiplexes two
    payload types: ``EventModel`` (a near-miss) and this one (a
    perception-quality heartbeat). The frontend picks which type a message
    is by checking ``_meta == "perception_state"``, so we declare ``meta``
    as a ``Literal`` — a type that allows exactly one string value — to
    keep that discriminator visible in the generated TS.

    Route: emitted over GET /stream/events. Consumed by the SSE client
    hook that feeds the dashboard's live panels.
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
    """Per-source stream status (one object per configured camera / video file).

    Reports whether that source is currently running, how many frames it
    has read vs processed, its uptime, playback position (for file
    sources), the last error it saw, and whether detection is enabled.

    Routes: returned as an element of the ``sources`` array in
    GET /api/live/sources and GET /api/live/status. Drives the per-slot
    tiles on the dashboard's multi-camera grid.
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

    "Threshold" = the cut-off number above which the system flags a
    near-miss. These four values are the current cut-offs for time-to-
    collision (``ttc_*_sec``, in seconds) and distance (``dist_*_m``, in
    metres). Urban scenes use tighter numbers than highway; parking is
    tighter still.

    Route: embedded in the response of GET /api/live/scene. Drives the
    "why this threshold" tooltip on the dashboard's scene banner.
    """

    ttc_high_sec: float
    ttc_med_sec: float
    dist_high_m: float
    dist_med_m: float


class SceneContextModel(BaseModel):
    """Scene classifier context attached to events and health endpoints.

    Tells the UI what *kind* of scene the camera is looking at: the
    ``label`` (``"urban"`` / ``"highway"`` / ``"parking"``), the
    classifier's ``confidence`` (0.0-1.0), a rough estimate of how fast
    the camera platform itself is moving (``speed_proxy_mps``, metres per
    second), and optional per-minute rates of people and vehicles seen.

    The extra ``pedestrian_rate_per_min`` / ``vehicle_rate_per_min`` /
    ``thresholds`` fields are only populated on GET /api/live/scene; on
    events we ship a trimmed 4-field subset to keep event payloads small.

    Routes: GET /api/live/scene, embedded in EventModel, embedded in
    GET /api/admin/health.
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

    "Ego-motion" = how fast OUR OWN camera platform is moving. It lets
    the system distinguish a rapidly-approaching obstacle from the scene
    simply panning past a stationary camera. ``speed_proxy_mps`` is the
    estimated speed in metres per second; ``confidence`` is 0.0-1.0.

    Routes: embedded in EventModel, GET /api/live/scene, and
    GET /api/admin/health.
    """

    speed_proxy_mps: float | None = None
    confidence: float | None = None

    model_config = ConfigDict(extra="allow")


class EnrichmentModel(BaseModel):
    """LLM / ALPR post-processing output attached to a safety event.

    "Enrichment" = extra attributes a language model or the ALPR
    (Automatic License Plate Recognition) pass adds AFTER the perception
    pipeline has produced an event: readability hint, vehicle colour,
    vehicle type, and the one-way hash of the plate text.

    SECURITY INVARIANT: ``plate_text`` / ``plate_state`` are deliberately
    NOT fields on this model. The backend strips them at ingest in
    ``enrich_event()``; only the hashed plate ever reaches the frontend.
    Adding a plate-text field here would defeat the in-memory redaction
    and let raw plates land in every SSE subscriber's buffer.

    Route: embedded in EventModel (so present on every event-returning
    endpoint).
    """

    plate_hash: str | None = None
    readability: str | None = None
    vehicle_color: str | None = None
    vehicle_type: str | None = None

    model_config = ConfigDict(extra="allow")


class EventModel(BaseModel):
    """Canonical safety-event contract shared across list/detail/chat contexts.

    A "safety event" is what the perception pipeline emits when it
    detects something notable — typically a near-miss. Every field that
    can be ``None`` (``| None = None``) is optional; the non-optional
    fields (``event_id``, ``event_type``, ``risk_level``) are the only
    guaranteed ones.

    Routes: returned by GET /api/live/events, GET /api/events,
    GET /api/events/{event_id}; embedded in the copilot chat responses
    and the SSE event stream. Drives the EventCard, EventDialog, and
    the clip-player on every page that lists events.
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
    """One detection (bounding box + class) within a per-frame snapshot.

    ``cls`` is the class string ("person", "car", …), ``conf`` is the
    detector's confidence (0.0-1.0), ``track_id`` is the multi-frame
    identity assigned by the tracker, and ``bbox`` is a four-number
    pixel-space box ``(x1, y1, x2, y2)``.

    Shape is flat on purpose: the admin overlay draws dozens of these
    per frame and any nested field access shows up in the profile.
    ``distance_axis`` tells the UI how to interpret ``distance_m`` —
    forward/rear cameras report ``"range"`` (longitudinal distance; TTC
    is meaningful); side cameras report ``"lateral"`` (sideways
    distance; TTC is not).

    Route: embedded in DetectionSnapshotModel; reaches the UI via the
    admin SSE stream.
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

    Describes everything the perception pipeline saw in a single frame:
    a wall-clock timestamp ``ts``, counts of persons / vehicles /
    interactions, and the full list of ``DetectionObjectModel`` entries
    with their bounding boxes.

    Produced by the perception thread inside ``on_frame.py``; consumed
    by the admin grid's overlay renderer. ``playback_pos_sec`` /
    ``playback_duration_sec`` are zero for live feeds and populated for
    looped local files so the map overlay marker stays locked to the
    frame the user is actually watching.

    Route: pushed over the admin SSE stream (no REST endpoint returns it
    directly).
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

    "Drift" = when the detector's real-world accuracy moves away from
    what was expected at deploy time. Reports how many true vs false
    positives the last ``window_size`` labelled events had, the
    resulting ``precision`` (0.0-1.0), and a trend string like "up" /
    "down" / "flat". ``alert_triggered`` flips to ``True`` when
    precision drops below a configured floor.

    Route: returned by GET /api/drift. Drives the drift banner on the
    dashboard.
    """

    window_size: int
    true_positives: int
    false_positives: int
    precision: float | None = None
    trend: str | None = None
    alert_triggered: bool | None = None

    model_config = ConfigDict(extra="allow")


class LiveSourcesResponse(BaseModel):
    """Response body for GET /api/live/sources.

    Wraps the full source list (one ``SourceStatusModel`` per configured
    camera / file) with a ``primary_id`` pointer so the UI knows which
    slot to highlight as "main". Drives the source selector dropdown and
    the multi-camera grid.
    """

    primary_id: str
    sources: list[SourceStatusModel]


class LiveStatusResponse(BaseModel):
    """Response body for GET /api/live/status.

    Dense summary used by the operator UI header: is the pipeline
    ``running``? how many frames has it seen? which integrations are
    configured (``llm_configured``, ``slack_configured``)? which sources
    are live (the ``sources`` array)? Drives the TopBar uptime widget
    and the dashboard's running/not-running indicator.
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
    """Response body for POST /chat.

    Single-field wrapper around the LLM-generated answer string. The
    wrapper exists (instead of returning the raw string) so future
    fields — follow-up suggestions, citations — can be added without
    breaking the FE contract. Drives the copilot chat panel's reply
    bubble.
    """

    answer: str


class StageTimingStatsModel(BaseModel):
    """Latency stats for one pipeline stage (values in milliseconds).

    ``p50_ms`` is the median — the stage took less than this on half
    the frames; ``p95_ms`` is the 95th-percentile — it took less than
    this on 95% of frames (a "typical worst case"); ``samples`` is how
    many datapoints the percentiles are computed over. Fields are
    ``None`` until the stage has produced enough samples to compute
    them.

    Route: embedded in ``stage_timings`` on GET /api/admin/health.
    """

    p50_ms: float | None = None
    p95_ms: float | None = None
    samples: int = 0


class AdminServerHealthModel(BaseModel):
    """Server-process health sub-model: uptime, started-at, primary source.

    Route: embedded as ``server`` in GET /api/admin/health. Drives the
    admin page's "server" tile.
    """

    running: bool
    uptime_sec: float
    started_at: float | None = None
    source: str
    location: str
    target_fps: float


class AdminPipelineHealthModel(BaseModel):
    """Perception-pipeline sub-model: frame counts, event counts, model ids.

    Route: embedded as ``pipeline`` in GET /api/admin/health. Drives the
    admin page's "pipeline" tile.
    """

    frames_read: int
    frames_processed: int
    event_count: int
    active_episodes: int
    tracker: str
    risk_model: str
    model: str


class AdminIntegrationsHealthModel(BaseModel):
    """Optional-integrations sub-model: which LLM / Slack / cloud bits are on.

    Route: embedded as ``integrations`` in GET /api/admin/health. Drives
    the admin page's "integrations" tile and the cloud-publisher toggle
    state.
    """

    llm_configured: bool
    slack_configured: bool
    edge_publisher: bool
    pii_redaction: str
    alpr_mode: str


class AdminHealthResponse(BaseModel):
    """Response body for GET /api/admin/health.

    Composite payload: one of every sub-health model above, plus a
    ``per_source`` map (keyed by source id) so multi-camera dashboards
    can render per-slot tiles. ``stage_timings`` is a nested dict —
    ``stage_timings["source_id"]["stage_name"]`` gives the
    ``StageTimingStatsModel`` for that stage on that source. Drives the
    entire admin page's dashboard tiles.
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

    Roughly mirrors a log-line-with-threshold. Example:
    ``label="frame drop rate"``, ``value="12%"``, ``threshold="<5%"``,
    ``status="failing"``. The watchdog groups these under each finding
    so the UI can render a compact evidence table rather than a prose
    blob.

    Route: embedded in ``WatchdogFindingModel.evidence``.
    """

    label: str
    value: str
    threshold: str | None = None
    status: str | None = None


class WatchdogFindingModel(BaseModel):
    """One emitted watchdog finding — operator-facing incident summary.

    "Watchdog" = a background task that periodically checks the system
    for problems and emits a record when it finds one. Each finding
    carries its ``severity`` (error / warning / info), ``category``,
    human-readable ``title`` / ``detail``, a suggested next step, and
    enough context (``evidence``, ``investigation_steps``,
    ``debug_commands``) for an on-call engineer to act without
    round-tripping through the source code.

    The ``fingerprint`` field is the dedup key: two findings with the
    same fingerprint are the same incident recurring, not two separate
    incidents.

    Route: returned by GET /api/watchdog/findings; embedded in
    ``WatchdogTopIncidentModel.latest``. Drives the monitoring page's
    incident cards.
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
    """Top-N incident summary embedded in the watchdog status payload.

    One per repeating incident: carries the dedup ``fingerprint``, the
    number of times it has fired (``count``), when it first and last
    fired, and the latest finding verbatim.

    Route: embedded as an element of ``WatchdogStatusModel.top_incidents``.
    """

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
    """Response body for GET /api/watchdog/status.

    Counters + grouped summary so the frontend can render the "incident
    queue" overview rather than a log-tail of every finding ever. The
    ``by_severity`` / ``by_category`` dicts are bucket counts; the
    ``top_incidents`` array is the current dashboard-worthy shortlist.

    Drives the monitoring page's header strip and the sidebar
    severity/category filters.
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
    """One pytest node result surfaced through the operator UI.

    A "node" is pytest's term for a single test function. ``outcome`` is
    a closed set — exactly one of ``"passed"`` / ``"failed"`` /
    ``"error"`` / ``"skipped"`` (declared with ``Literal`` so TS gets a
    union of those four strings). ``duration_ms`` is how long the test
    took; ``message`` carries the failure/error text when the test did
    not pass.

    Route: embedded in ``TestStatusModel.results``.
    """

    name: str
    node_id: str
    file: str
    outcome: Literal["passed", "failed", "error", "skipped"]
    duration_ms: float
    message: str | None = None


class TestStatusModel(BaseModel):
    """Response body for GET /api/tests/status.

    Rolled-up counts (``total`` / ``passed`` / ``failed`` / ``skipped``)
    plus the full per-node ``results`` list. ``status`` is one of
    ``"idle"`` / ``"running"`` / ``"passed"`` / ``"failed"`` and drives
    the run/stop button state in the operator UI. ``progress`` is a
    0.0-1.0 fraction driving the progress bar.
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
