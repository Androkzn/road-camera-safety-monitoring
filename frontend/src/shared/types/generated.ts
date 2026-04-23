/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Produced from ``backend/api/models.py`` by
 * ``scripts/generate_ts_types.py``. Edit the pydantic models, then
 * re-run the script (``python scripts/generate_ts_types.py``) — the
 * frontend build runs it automatically via ``start.py``.
 */

/* eslint-disable */

/**
 * Response body for GET /api/admin/health.
 *
 * Composite payload: one of every sub-health model above, plus a
 * ``per_source`` map (keyed by source id) so multi-camera dashboards
 * can render per-slot tiles. ``stage_timings`` is a nested dict —
 * ``stage_timings["source_id"]["stage_name"]`` gives the
 * ``StageTimingStatsModel`` for that stage on that source. Consumed
 * by the ``useAdminHealth`` hook; drives the AdminPage HealthStrip
 * and every admin-dashboard tile.
 */
export interface HealthData {
  server: AdminServerHealth;
  pipeline: AdminPipelineHealth;
  integrations: AdminIntegrationsHealth;
  perception: PerceptionState;
  scene: SceneContext;
  ego: EgoFlow;
  stage_timings: Record<string, Record<string, StageTimingStats>>;
  per_source: Record<string, Record<string, unknown>>;
}

/**
 * Optional-integrations sub-model: which LLM / Slack / cloud bits are on.
 *
 * Route: embedded as ``integrations`` in GET /api/admin/health. Drives
 * the admin page's "integrations" tile and the cloud-publisher toggle
 * state.
 */
export interface AdminIntegrationsHealth {
  llm_configured: boolean;
  slack_configured: boolean;
  edge_publisher: boolean;
  pii_redaction: string;
  alpr_mode: string;
}

/**
 * Perception-pipeline sub-model: frame counts, event counts, model ids.
 *
 * Route: embedded as ``pipeline`` in GET /api/admin/health. Drives the
 * admin page's "pipeline" tile.
 */
export interface AdminPipelineHealth {
  frames_read: number;
  frames_processed: number;
  event_count: number;
  active_episodes: number;
  tracker: string;
  risk_model: string;
  model: string;
}

/**
 * Server-process health sub-model: uptime, started-at, primary source.
 *
 * Route: embedded as ``server`` in GET /api/admin/health. Drives the
 * admin page's "server" tile.
 */
export interface AdminServerHealth {
  running: boolean;
  uptime_sec: number;
  started_at?: number;
  source: string;
  location: string;
  target_fps: number;
}

/**
 * Response body for POST /chat.
 *
 * Single-field wrapper around the LLM-generated answer string. The
 * wrapper exists (instead of returning the raw string) so future
 * fields — follow-up suggestions, citations — can be added without
 * breaking the FE contract. Consumed by the ``useChat`` hook; drives
 * the copilot chat panel's reply bubble.
 */
export interface ChatResponse {
  answer: string;
}

/**
 * One detection (bounding box + class) within a per-frame snapshot.
 *
 * ``cls`` is the class string ("person", "car", …), ``conf`` is the
 * detector's confidence (0.0-1.0), ``track_id`` is the multi-frame
 * identity assigned by the tracker, and ``bbox`` is a four-number
 * pixel-space box ``(x1, y1, x2, y2)``.
 *
 * Shape is flat on purpose: the admin overlay draws dozens of these
 * per frame and any nested field access shows up in the profile.
 * ``distance_axis`` tells the UI how to interpret ``distance_m`` —
 * forward/rear cameras report ``"range"`` (longitudinal distance; TTC
 * is meaningful); side cameras report ``"lateral"`` (sideways
 * distance; TTC is not).
 *
 * Route: embedded in DetectionSnapshotModel; reaches the UI via the
 * /admin/detections SSE stream, consumed by ``useDetections``.
 */
export interface DetectionObject {
  cls: string;
  conf: number;
  track_id?: number;
  bbox: [number, number, number, number];
  distance_m?: number;
  distance_axis?: "range" | "lateral";
}

/**
 * One per-frame snapshot broadcast over the admin SSE stream.
 *
 * Describes everything the perception pipeline saw in a single frame:
 * a wall-clock timestamp ``ts``, counts of persons / vehicles /
 * interactions, and the full list of ``DetectionObjectModel`` entries
 * with their bounding boxes.
 *
 * Produced by the perception thread inside ``on_frame.py``; consumed
 * by the admin grid's overlay renderer. ``playback_pos_sec`` /
 * ``playback_duration_sec`` are zero for live feeds and populated for
 * looped local files so the map overlay marker stays locked to the
 * frame the user is actually watching.
 *
 * Route: pushed over the /admin/detections SSE stream (no REST
 * endpoint returns it directly). Consumed by the ``useDetections``
 * hook that feeds the AdminPage bounding-box overlay.
 */
export interface DetectionSnapshot {
  ts: number;
  source_id?: string;
  source_name?: string;
  detections: number;
  persons: number;
  vehicles: number;
  interactions: number;
  objects: Array<DetectionObject>;
  playback_pos_sec?: number;
  playback_duration_sec?: number;
}

/**
 * Rolling precision report from the operator-feedback drift monitor.
 *
 * "Drift" = when the detector's real-world accuracy moves away from
 * what was expected at deploy time. Reports how many true vs false
 * positives the last ``window_size`` labelled events had, the
 * resulting ``precision`` (0.0-1.0), and a trend string like "up" /
 * "down" / "flat". ``alert_triggered`` flips to ``True`` when
 * precision drops below a configured floor.
 *
 * Route: returned by GET /api/drift. Drives the drift banner on the
 * dashboard.
 */
export interface DriftReport {
  window_size: number;
  true_positives: number;
  false_positives: number;
  precision?: number;
  trend?: string;
  alert_triggered?: boolean;
}

/**
 * Ego-motion summary attached to events and health endpoints.
 *
 * "Ego-motion" = how fast OUR OWN camera platform is moving. It lets
 * the system distinguish a rapidly-approaching obstacle from the scene
 * simply panning past a stationary camera. ``speed_proxy_mps`` is the
 * estimated speed in metres per second; ``confidence`` is 0.0-1.0.
 *
 * Routes: embedded in EventModel, GET /api/live/scene, and
 * GET /api/admin/health.
 */
export interface EgoFlow {
  speed_proxy_mps?: number;
  confidence?: number;
}

/**
 * LLM / ALPR post-processing output attached to a safety event.
 *
 * "Enrichment" = extra attributes a language model or the ALPR
 * (Automatic License Plate Recognition) pass adds AFTER the perception
 * pipeline has produced an event: readability hint, vehicle colour,
 * vehicle type, and the one-way hash of the plate text.
 *
 * SECURITY INVARIANT: ``plate_text`` / ``plate_state`` are deliberately
 * NOT fields on this model. The backend strips them at ingest in
 * ``enrich_event()``; only the hashed plate ever reaches the frontend.
 * Adding a plate-text field here would defeat the in-memory redaction
 * and let raw plates land in every SSE subscriber's buffer.
 *
 * Route: embedded in EventModel (so present on every event-returning
 * endpoint).
 */
export interface Enrichment {
  plate_hash?: string;
  readability?: string;
  vehicle_color?: string;
  vehicle_type?: string;
}

/**
 * Canonical safety-event contract shared across list/detail/chat contexts.
 *
 * A "safety event" is what the perception pipeline emits when it
 * detects something notable — typically a near-miss. Every field that
 * can be ``None`` (``| None = None``) is optional; the non-optional
 * fields (``event_id``, ``event_type``, ``risk_level``) are the only
 * guaranteed ones.
 *
 * Routes: returned by GET /api/live/events, GET /api/events,
 * GET /api/events/{event_id}; embedded in the copilot chat responses
 * and the /stream/events SSE channel. Consumed by the
 * ``useEventStream`` / ``useHistory`` hooks; drives the EventCard,
 * EventDialog, and the clip-player on every page that lists events.
 */
export interface SafetyEvent {
  event_id: string;
  source_id?: string;
  source_name?: string;
  vehicle_id?: string;
  road_id?: string;
  driver_id?: string;
  video_id?: string;
  timestamp_sec?: number;
  wall_time?: string;
  event_type: string;
  internal_event_type?: string;
  risk_level: "high" | "medium" | "low";
  peak_risk_level?: "high" | "medium" | "low";
  risk_demoted?: boolean;
  risk_frame_counts: Record<string, number>;
  frame_count?: number;
  confidence?: number;
  objects: Array<string>;
  track_ids: Array<number>;
  episode_duration_sec?: number;
  camera_orientation?: string;
  event_taxonomy?: string;
  policy_reason?: string;
  ttc_sec?: number;
  distance_m?: number;
  distance_px?: number;
  scene_context?: SceneContext;
  ego_flow?: EgoFlow;
  summary?: string;
  narration?: string;
  thumbnail?: string;
  enrichment_skipped?: string;
  enrichment?: Enrichment;
  perception_state?: string;
}

/**
 * Response body for GET /api/live/sources.
 *
 * Wraps the full source list (one ``SourceStatusModel`` per configured
 * camera / file) with a ``primary_id`` pointer so the UI knows which
 * slot to highlight as "main". Consumed by the ``useLiveSourcesList``
 * hook; drives the source selector dropdown and the multi-camera grid.
 */
export interface LiveSourcesResponse {
  primary_id: string;
  sources: Array<LiveSourceStatus>;
}

/**
 * Response body for GET /api/live/status.
 *
 * Dense summary used by the operator UI header: is the pipeline
 * ``running``? how many frames has it seen? which integrations are
 * configured (``llm_configured``, ``slack_configured``)? which sources
 * are live (the ``sources`` array)? Consumed by the ``useLiveStatus``
 * hook; drives the TopBar connection pill and the dashboard's
 * running/not-running banners.
 */
export interface LiveStatus {
  source: string;
  location: string;
  running: boolean;
  event_count: number;
  frames_read: number;
  frames_processed: number;
  uptime_sec: number;
  started_at?: number;
  llm_configured: boolean;
  slack_configured: boolean;
  target_fps: number;
  active_episodes: number;
  tracker: string;
  risk_model: string;
  pii_redaction: string;
  alpr_mode: string;
  perception: PerceptionState;
  sources: Array<LiveSourceStatus>;
  primary_id: string;
}

/**
 * SSE message envelope for a perception-state update.
 *
 * SSE = Server-Sent Events: a long-lived HTTP stream the server pushes
 * JSON lines down. The ``/stream/events`` SSE channel multiplexes two
 * payload types: ``EventModel`` (a near-miss) and this one (a
 * perception-quality heartbeat). The frontend picks which type a message
 * is by checking ``_meta == "perception_state"``, so we declare ``meta``
 * as a ``Literal`` — a type that allows exactly one string value — to
 * keep that discriminator visible in the generated TS.
 *
 * Route: emitted over GET /stream/events. Consumed by the
 * ``useEventStream`` hook (via ``EventStreamProvider``) that feeds the
 * dashboard's live panels.
 */
export interface PerceptionStateMessage {
  _meta: "perception_state";
  state: string;
  reason?: string;
  samples?: number;
  since_sec?: number;
  avg_confidence?: number;
  luminance?: number;
  sharpness?: number;
}

/**
 * Live perception-quality summary (how well the camera is seeing right now).
 *
 * Carries luminance (how bright the image is), sharpness (how in-focus),
 * a running average of detection confidence, and a short human-readable
 * ``reason`` string.
 *
 * Routes: embedded in GET /api/live/status and GET /api/admin/health.
 * Consumed by the ``useLiveStatus`` and ``useAdminHealth`` hooks;
 * drives the "perception health" dot on the operator UI header.
 */
export interface PerceptionState {
  state: string;
  reason?: string;
  samples?: number;
  since_sec?: number;
  avg_confidence?: number;
  luminance?: number;
  sharpness?: number;
}

/**
 * Scene classifier context attached to events and health endpoints.
 *
 * Tells the UI what *kind* of scene the camera is looking at: the
 * ``label`` (``"urban"`` / ``"highway"`` / ``"parking"``), the
 * classifier's ``confidence`` (0.0-1.0), a rough estimate of how fast
 * the camera platform itself is moving (``speed_proxy_mps``, metres per
 * second), and optional per-minute rates of people and vehicles seen.
 *
 * The extra ``pedestrian_rate_per_min`` / ``vehicle_rate_per_min`` /
 * ``thresholds`` fields are only populated on GET /api/live/scene; on
 * events we ship a trimmed 4-field subset to keep event payloads small.
 *
 * Routes: GET /api/live/scene, embedded in EventModel, embedded in
 * GET /api/admin/health.
 */
export interface SceneContext {
  label: string;
  confidence?: number;
  speed_proxy_mps?: number;
  pedestrian_rate_per_min?: number;
  vehicle_rate_per_min?: number;
  reason?: string;
  thresholds?: SceneThresholds;
}

/**
 * Adaptive risk thresholds rescaled per scene label.
 *
 * "Threshold" = the cut-off number above which the system flags a
 * near-miss. These four values are the current cut-offs for time-to-
 * collision (``ttc_*_sec``, in seconds) and distance (``dist_*_m``, in
 * metres). Urban scenes use tighter numbers than highway; parking is
 * tighter still.
 *
 * Route: embedded in the response of GET /api/live/scene. Drives the
 * "why this threshold" tooltip on the dashboard's scene banner.
 */
export interface SceneThresholds {
  ttc_high_sec: number;
  ttc_med_sec: number;
  dist_high_m: number;
  dist_med_m: number;
}

/**
 * Per-source stream status (one object per configured camera / video file).
 *
 * Reports whether that source is currently running, how many frames it
 * has read vs processed, its uptime, playback position (for file
 * sources), the last error it saw, and whether detection is enabled.
 *
 * Routes: returned as an element of the ``sources`` array in
 * GET /api/live/sources and GET /api/live/status. Consumed by the
 * ``useLiveSourcesList`` and ``useLiveStatus`` hooks; drives the
 * per-slot tiles on the dashboard's multi-camera grid.
 */
export interface LiveSourceStatus {
  id: string;
  name: string;
  url: string;
  stream_type: "dashcam_file" | "live_yt" | "live_hls" | "webcam" | "unknown";
  running: boolean;
  detection_enabled: boolean;
  last_error?: string;
  frames_read: number;
  frames_processed: number;
  uptime_sec: number;
  playback_pos_sec: number;
  playback_duration_sec: number;
  started_at?: number;
  active_episodes: number;
  perception_state?: string;
  perception_reason?: string;
}

/**
 * Latency stats for one pipeline stage (values in milliseconds).
 *
 * ``p50_ms`` is the median — the stage took less than this on half
 * the frames; ``p95_ms`` is the 95th-percentile — it took less than
 * this on 95% of frames (a "typical worst case"); ``samples`` is how
 * many datapoints the percentiles are computed over. Fields are
 * ``None`` until the stage has produced enough samples to compute
 * them.
 *
 * Route: embedded in ``stage_timings`` on GET /api/admin/health.
 */
export interface StageTimingStats {
  p50_ms?: number;
  p95_ms?: number;
  samples?: number;
}

/**
 * One pytest node result surfaced through the operator UI.
 *
 * A "node" is pytest's term for a single test function. ``outcome`` is
 * a closed set — exactly one of ``"passed"`` / ``"failed"`` /
 * ``"error"`` / ``"skipped"`` (declared with ``Literal`` so TS gets a
 * union of those four strings). ``duration_ms`` is how long the test
 * took; ``message`` carries the failure/error text when the test did
 * not pass.
 *
 * Route: embedded in ``TestStatusModel.results``.
 */
export interface TestResult {
  name: string;
  node_id: string;
  file: string;
  outcome: "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  message?: string;
}

/**
 * Response body for GET /api/tests/status.
 *
 * Rolled-up counts (``total`` / ``passed`` / ``failed`` / ``skipped``)
 * plus the full per-node ``results`` list. ``status`` is one of
 * ``"idle"`` / ``"running"`` / ``"passed"`` / ``"failed"`` and drives
 * the run/stop button state in the operator UI. ``progress`` is a
 * 0.0-1.0 fraction driving the progress bar. Consumed by the
 * ``useTests`` hook on the TestsPage.
 */
export interface TestStatus {
  status: "idle" | "running" | "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  progress: number;
  elapsed_sec: number;
  results: Array<TestResult>;
}

/**
 * One row of evidence attached to a watchdog finding.
 *
 * Roughly mirrors a log-line-with-threshold. Example:
 * ``label="frame drop rate"``, ``value="12%"``, ``threshold="<5%"``,
 * ``status="failing"``. The watchdog groups these under each finding
 * so the UI can render a compact evidence table rather than a prose
 * blob.
 *
 * Route: embedded in ``WatchdogFindingModel.evidence``.
 */
export interface WatchdogEvidence {
  label: string;
  value: string;
  threshold?: string;
  status?: string;
}

/**
 * One emitted watchdog finding — operator-facing incident summary.
 *
 * "Watchdog" = a background task that periodically checks the system
 * for problems and emits a record when it finds one. Each finding
 * carries its ``severity`` (error / warning / info), ``category``,
 * human-readable ``title`` / ``detail``, a suggested next step, and
 * enough context (``evidence``, ``investigation_steps``,
 * ``debug_commands``) for an on-call engineer to act without
 * round-tripping through the source code.
 *
 * The ``fingerprint`` field is the dedup key: two findings with the
 * same fingerprint are the same incident recurring, not two separate
 * incidents.
 *
 * Route: returned as elements of the ``findings`` array on
 * GET /api/watchdog/recent; embedded in
 * ``WatchdogTopIncidentModel.latest``. Consumed by the
 * ``useWatchdogCtx`` context; drives the MonitoringPage's incident
 * cards.
 */
export interface WatchdogFinding {
  severity: "error" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  suggestion: string;
  impact?: string;
  likely_cause?: string;
  owner?: string;
  runbook?: string;
  fingerprint?: string;
  source?: "rule" | "ai";
  cause_confidence?: "observed" | "inferred";
  priority_score?: number;
  evidence: Array<WatchdogEvidence>;
  investigation_steps: Array<string>;
  debug_commands: Array<string>;
  ts: string;
  snapshot_id: string;
}

/**
 * Response body for GET /api/watchdog.
 *
 * Counters + grouped summary so the frontend can render the "incident
 * queue" overview rather than a log-tail of every finding ever. The
 * ``by_severity`` / ``by_category`` dicts are bucket counts; the
 * ``top_incidents`` array is the current dashboard-worthy shortlist.
 *
 * Consumed by the ``useWatchdogCtx`` context; drives the
 * MonitoringPage's header strip and the sidebar severity/category
 * filters.
 */
export interface WatchdogStatus {
  enabled: boolean;
  interval_sec: number;
  last_run: number;
  last_run_ago_sec?: number;
  run_count: number;
  total_findings_emitted: number;
  total_findings: number;
  unique_incidents?: number;
  repeating_incidents?: number;
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
  top_incidents: Array<WatchdogTopIncident>;
}

/**
 * Top-N incident summary embedded in the watchdog status payload.
 *
 * One per repeating incident: carries the dedup ``fingerprint``, the
 * number of times it has fired (``count``), when it first and last
 * fired, and the latest finding verbatim.
 *
 * Route: embedded as an element of ``WatchdogStatusModel.top_incidents``.
 */
export interface WatchdogTopIncident {
  fingerprint: string;
  severity: string;
  category: string;
  title: string;
  owner: string;
  count: number;
  first_seen_ts: string;
  last_seen_ts: string;
  latest: WatchdogFinding;
}
