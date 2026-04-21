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
 * Response model for GET /api/admin/health.
 *
 * Composite of every sub-health model above, plus a ``per_source`` map
 * so multi-camera dashboards can render per-slot tiles.
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
 * Which optional integrations (LLM, Slack, cloud) are configured + enabled.
 */
export interface AdminIntegrationsHealth {
  llm_configured: boolean;
  slack_configured: boolean;
  edge_publisher: boolean;
  pii_redaction: string;
  alpr_mode: string;
}

/**
 * Perception pipeline counters: frames, events, tracker + risk-model ids.
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
 * Server process health: uptime, started-at, primary source.
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
 * Response model for POST /chat.
 *
 * Single field: the LLM-generated answer string. Used by the copilot
 * Q&A endpoint.
 */
export interface ChatResponse {
  answer: string;
}

/**
 * One detection within a per-frame snapshot.
 *
 * Flat shape because the admin overlay draws dozens per frame and any
 * nested field access shows up in the profile. ``distance_axis`` is the
 * semantic axis of ``distance_m`` — forward/rear cameras report
 * ``"range"`` (longitudinal distance; TTC is meaningful); side cameras
 * report ``"lateral"`` (sideways distance; TTC is not).
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
 * Produced by the perception thread inside ``on_frame.py``; consumed by
 * the admin grid's overlay renderer. ``playback_pos_sec`` /
 * ``playback_duration_sec`` are zero for live feeds and populated for
 * looped local files so the map overlay marker stays locked to the
 * frame the user is actually watching.
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
 * Tracks whether the ratio of labelled true-vs-false positives is
 * drifting — a drop in precision is often the first signal that a
 * scene or lens change has invalidated the current thresholds.
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
 * Ego-motion = "how fast is our own camera platform moving?" — used to
 * distinguish a rapidly-approaching obstacle from the scene simply
 * panning past the camera.
 */
export interface EgoFlow {
  speed_proxy_mps?: number;
  confidence?: number;
}

/**
 * LLM / ALPR post-processing output attached to a safety event.
 *
 * SECURITY INVARIANT: ``plate_text`` / ``plate_state`` are deliberately
 * NOT fields on this model. The backend strips them at ingest in
 * ``enrich_event()``; only the hashed plate ever reaches the frontend.
 * Adding a plate-text field here would defeat the in-memory redaction
 * and let raw plates land in every SSE subscriber's buffer.
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
 * A safety event is what the perception pipeline emits when a near-miss
 * (or similar) is detected. Every list-of-events endpoint, event-detail
 * endpoint, and the copilot chat backend all agree on this shape.
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
 * Response model for GET /api/live/sources.
 *
 * Wraps the full source list with a ``primary_id`` pointer so the UI
 * knows which slot to highlight as "main".
 */
export interface LiveSourcesResponse {
  primary_id: string;
  sources: Array<LiveSourceStatus>;
}

/**
 * Public live status response contract.
 *
 * Dense summary used by the operator UI header: is the pipeline
 * running? how many frames? which integrations configured? which
 * sources live? Returned by GET /api/live/status.
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
 * The ``/stream/events`` SSE channel multiplexes two payload types:
 * ``SafetyEvent`` (a near-miss) and this one (a perception-quality
 * heartbeat). The frontend discriminates on ``_meta == "perception_state"``
 * — so we model it here as a ``Literal`` field to keep that contract
 * visible in the generated TS instead of living as an undeclared
 * string on the event object.
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
 * Live perception-quality summary.
 *
 * Describes *how well* the camera is seeing right now: luminance,
 * sharpness, running average of detection confidence, and a short
 * human-readable reason string. Attached to live/status and admin
 * health responses.
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
 * Carries the scene label (urban / highway / parking), its confidence,
 * and an ego-speed proxy derived from optical flow. The optional
 * ``pedestrian_rate_per_min`` / ``vehicle_rate_per_min`` / ``thresholds``
 * fields are populated by ``/api/live/scene`` only — on emitted events
 * we ship the trimmed 4-field subset.
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
 * Emitted alongside the scene context by ``/api/live/scene`` so the UI
 * can surface *why* the current near-miss gates are where they are
 * (urban thresholds are tighter than highway, parking is tighter than
 * urban). Every threshold value is in its natural unit — seconds for
 * TTC, metres for distance — so the UI can render them directly.
 */
export interface SceneThresholds {
  ttc_high_sec: number;
  ttc_med_sec: number;
  dist_high_m: number;
  dist_med_m: number;
}

/**
 * Per-source stream status used by live source/status endpoints.
 *
 * One of these is returned per configured camera/video-file slot —
 * frame counters, playback position, detection toggle, last error, etc.
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
 * Latency stats for one pipeline stage.
 *
 * p50 = median, p95 = 95th-percentile, samples = how many datapoints
 * the percentiles are computed over. ``None`` when no samples yet.
 */
export interface StageTimingStats {
  p50_ms?: number;
  p95_ms?: number;
  samples?: number;
}

/**
 * One pytest node result surfaced through the operator UI.
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
 * Response model for GET /api/tests/status.
 *
 * Rolled-up counts + the full per-node result list. ``status`` drives
 * the run/stop button state in the operator UI.
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
 * Roughly mirrors a log-line-with-threshold: label ("frame drop rate"),
 * value ("12%"), optional threshold ("<5%"), and optional status tag
 * ("failing" / "warning"). The watchdog groups these under each finding
 * so the UI can render a compact evidence table rather than a prose blob.
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
 * The watchdog produces a queue of fingerprinted incidents (dedup key is
 * ``fingerprint``). Each finding carries its severity, category,
 * human-readable title/detail, suggested next step, and enough context
 * (evidence, investigation_steps, debug_commands) for an on-call to act
 * without round-tripping through the source code.
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
 * Response model for GET /api/watchdog/status.
 *
 * Counters + grouped summary so the frontend can render the "incident
 * queue" overview (as opposed to a log-tail of every finding ever).
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
