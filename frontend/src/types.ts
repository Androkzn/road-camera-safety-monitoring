/**
 * types.ts — Shared TypeScript type declarations for the frontend.
 *
 * WHAT THIS FILE IS
 *   A pure type-definition module. It contains NO runtime code — when the
 *   TypeScript compiler emits JavaScript, everything in this file is erased.
 *   These are compile-time contracts only.
 *
 *   Each `interface` below mirrors a JSON shape produced by the FastAPI
 *   backend (see road_safety/server.py and road_safety/services/*). Hooks
 *   (frontend/src/hooks/*) fetch JSON from `/api/...` endpoints or receive it
 *   over SSE, then cast/validate it against these types so downstream
 *   components get autocomplete and catch typos at build time.
 *
 * WHERE IT FITS
 *   Backend  --(JSON)-->  hooks/use*.ts  --(typed)-->  components/*
 *                         ^^ import types from here ^^
 *
 * TYPESCRIPT CONCEPTS INTRODUCED
 *   - `interface Foo { ... }`: describes the shape of an object. Like a struct
 *     declaration that only exists at compile time.
 *   - `interface` vs `type`: largely interchangeable for objects. `interface`
 *     is conventional for object shapes (and supports declaration-merging).
 *     `type` is used when we need unions, intersections, tuples, etc.
 *   - Optional field `foo?: T`: the key may be missing OR `undefined`. The
 *     backend often omits fields it has no data for, so most fields are `?`.
 *   - Union types `"high" | "medium" | "low"`: the value must be one of these
 *     exact string literals. Catches typos like `"Low"` at compile time.
 *   - Tuple type `[number, number, number, number]`: an array of fixed length
 *     with per-slot types. Used for bounding boxes (x1, y1, x2, y2).
 *   - Index signature `Record<string, number>`: "any string key -> number".
 *     Used for dynamic dictionaries (e.g. `by_severity: {error: 3, warn: 2}`).
 *   - `export`: makes the interface importable from other files.
 */

// =============================================================================
// Event enrichment (LLM/ALPR post-processing output)
// =============================================================================

/**
 * Data attached to an event by the LLM enrichment step.
 * Produced by: road_safety/services/llm.py::enrich_event
 * Consumed by: components that display event cards (EventCard, AdminEventCard).
 *
 * SECURITY NOTE: `plate_text` / `plate_state` are deliberately NOT in this
 * type. The backend strips them at ingest (see CLAUDE.md "privacy invariant").
 * Only the hashed plate ever reaches the frontend.
 */
export interface Enrichment {
  plate_hash?: string;     // SHA-hash of the license plate; safe to display.
  readability?: string;    // e.g. "clear" | "partial" | "unreadable".
  vehicle_color?: string;  // Free-text colour label from the LLM.
  vehicle_type?: string;   // e.g. "sedan", "truck", "motorcycle".
}

// =============================================================================
// Core event — the primary payload pushed over SSE
// =============================================================================

/**
 * A conflict/safety event emitted by the detection pipeline.
 * Produced by: road_safety/server.py::_emit_event (streamed as SSE data).
 * Consumed by: hooks/useEventStream.ts, hooks/useSSE.ts, then rendered by
 *              EventCard / AdminEventCard.
 *
 * Many fields are optional because the backend omits data it couldn't
 * compute for a given frame (e.g. no LLM narration if the budget is spent).
 */
export interface SafetyEvent {
  event_id: string;                               // Unique per event; used as React `key`.
  vehicle_id?: string;                            // From ROAD_VEHICLE_ID env.
  road_id?: string;                               // From ROAD_ID env.
  driver_id?: string;                             // From ROAD_DRIVER_ID env.
  video_id?: string;                              // Source clip identifier.
  timestamp_sec?: number;                         // Seconds into the stream.
  wall_time?: string;                             // ISO-8601 UTC wall clock.
  event_type: string;                             // e.g. "near_miss", "harsh_brake".
  risk_level: "high" | "medium" | "low";          // Union: one of these 3 exact strings.
  confidence?: number;                            // 0..1 detector confidence.
  objects?: string[];                             // Class names involved, e.g. ["person","car"].
  track_ids?: number[];                           // ByteTrack IDs of the involved tracks.
  episode_duration_sec?: number;                  // How long the risk sustained.
  ttc_sec?: number;                               // Time-to-collision.
  distance_m?: number;                            // Metric distance if depth-gate succeeded.
  distance_px?: number;                           // Pixel distance fallback.
  summary?: string;                               // Short auto-generated one-liner.
  narration?: string;                             // Longer LLM-written description.
  thumbnail?: string;                             // Base64 or path to the PUBLIC (redacted) thumb.
  enrichment?: Enrichment;                        // Nested shape defined above.
  enrichment_skipped?: string;                    // Reason string if LLM wasn't called.
  perception_state?: string;                      // Snapshot of quality state at emit time.
  _meta?: string;                                 // Discriminator for non-event SSE messages.
}

// =============================================================================
// Perception / live status — telemetry about the pipeline itself
// =============================================================================

/**
 * Health snapshot about the QualityMonitor (services/quality.py).
 * Produced by: `/api/live/status` (poll) or embedded in SSE as a `_meta` msg.
 * Consumed by: components/dashboard/PerceptionBanner.tsx, HealthStrip.tsx.
 */
export interface PerceptionState {
  _meta: "perception_state";   // Literal type: MUST equal this exact string.
                               // Used as a discriminant to tell this apart
                               // from other SSE message shapes at runtime.
  state: string;               // e.g. "healthy" | "degraded" | "blind".
  reason: string;              // Human-readable cause of the state.
  luminance?: number;          // 0..255 average frame brightness.
  sharpness?: number;          // Laplacian variance (higher = sharper).
  avg_confidence?: number;     // Running mean of detector confidence.
  samples?: number;            // Sample count the averages were computed over.
}

/**
 * Top-level live status (from `/api/live/status`).
 * Consumed by: hooks/useLiveStatus.ts.
 */
export interface LiveStatus {
  source: string;                  // File path, HLS URL, or camera id.
  running: boolean;                // Is the detection loop alive?
  event_count: number;             // Events emitted this session.
  frames_read: number;             // Frames pulled from the stream.
  frames_processed: number;        // Frames that actually ran through YOLO.
  uptime_sec: number;              // Seconds since server start.
  started_at: number | null;       // Unix ts, or null if not running.
  perception?: PerceptionState;    // Nested quality snapshot.
  target_fps?: number;             // Server-side perception loop tick rate.
  alpr_mode?: string;              // External ALPR posture (off/on/on_demand).
  location?: string;               // Free-form location tag.
}

/**
 * Per-source perception slot status, returned by `/api/live/sources`
 * and the start/pause endpoints. Mirrors `StreamSlot.status_dict()` in
 * road_safety/server.py.
 */
export interface LiveSourceStatus {
  id: string;
  name: string;
  url: string;
  running: boolean;
  detection_enabled: boolean;
  last_error: string | null;
  frames_read: number;
  frames_processed: number;
  uptime_sec: number;
  started_at: number | null;
  active_episodes: number;
  perception_state: string | null;
  perception_reason: string | null;
}

export interface LiveSourcesResponse {
  primary_id: string;
  sources: LiveSourceStatus[];
}

// =============================================================================
// Scene context & drift — higher-level pipeline signals
// =============================================================================

/**
 * Output of SceneContextClassifier (core/context.py).
 * Produced by: `/api/road/scene`.
 * Consumed by: hooks/useScene.ts.
 */
export interface SceneContext {
  label: string;                         // "urban" | "highway" | "parking" | ...
  confidence?: number;                   // 0..1.
  speed_proxy_mps?: number;              // Ego-motion speed estimate, m/s.
  pedestrian_rate_per_min?: number;      // Heuristic density metric.
  reason: string;                        // Why the classifier chose this label.
  // Nested inline object type. `thresholds` is optional; if present it has
  // exactly these four required numeric fields (no `?` on the children).
  thresholds?: {
    ttc_high_sec: number;
    ttc_med_sec: number;
    dist_high_m: number;
    dist_med_m: number;
  };
}

/**
 * Model-drift report (services/drift.py).
 * Produced by: `/api/road/drift` (admin-only).
 * Consumed by: hooks/useDrift.ts.
 */
export interface DriftReport {
  window_size: number;
  true_positives: number;
  false_positives: number;
  precision?: number;            // TP / (TP + FP); undefined if zero samples.
  trend?: string;                // e.g. "stable" | "degrading".
  alert_triggered?: boolean;
}

// =============================================================================
// Raw detections — per-frame debug overlay data
// =============================================================================

/**
 * A single bounding-box detection in a frame.
 * Produced by: road_safety server detection debug endpoint.
 * Consumed by: components/admin/DetectionsPanel.tsx / VideoFeed.tsx.
 */
export interface DetectionObject {
  cls: string;                                     // Class name, e.g. "person".
  conf: number;                                    // Confidence 0..1.
  track_id?: number;                               // ByteTrack id (if tracked).
  // Tuple type: exactly four numbers, [x1, y1, x2, y2] in pixel coordinates.
  bbox: [number, number, number, number];
}

/**
 * A snapshot of detector output for one frame. Consumed by hooks/useDetections.ts.
 */
export interface DetectionSnapshot {
  ts: number;                          // Snapshot timestamp.
  detections: number;                  // Total boxes this frame.
  persons: number;                     // Breakdown: people count.
  vehicles: number;                    // Breakdown: vehicle count.
  interactions: number;                // Pairs flagged by find_interactions.
  objects: DetectionObject[];          // Array of the boxes themselves.
}

// =============================================================================
// Health endpoint — aggregated server/integration/scene info
// =============================================================================

/**
 * Fat health payload for the admin UI.
 * Produced by: `/api/admin/health` (admin-only).
 * Consumed by: hooks/useAdminHealth.ts -> components/admin/HealthStrip.tsx.
 *
 * Uses nested inline object types (instead of extracting them) because these
 * sub-shapes are only used inside HealthData.
 */
export interface HealthData {
  server: {
    running: boolean;
    uptime_sec: number;
    started_at: number | null;
    source: string;
    target_fps: number;
  };
  pipeline: {
    frames_read: number;
    frames_processed: number;
    event_count: number;
    active_episodes: number;
    tracker: string;
    risk_model: string;
    model: string;
  };
  integrations: {
    llm_configured: boolean;
    slack_configured: boolean;
    edge_publisher: boolean;
    pii_redaction: string;
    dsar_endpoint: boolean;
  };
  perception: {
    state: string;
    reason: string;
    samples: number;
    avg_confidence?: number;
    luminance?: number;
    sharpness?: number;
  };
  scene: {
    label: string;
    confidence?: number;
    speed_proxy_mps?: number;
    reason: string;
  };
}

// =============================================================================
// Watchdog — fingerprinted incident findings
// =============================================================================

/**
 * A single watchdog finding (an incident, not a log line).
 * Produced by: road_safety/services/watchdog.py.
 * Consumed by: hooks/useWatchdog.ts, components/watchdog/*.
 *
 * `severity` is a string-literal union: only these three exact values are
 * allowed. TypeScript will flag `severity: "critical"` as an error.
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
  fingerprint?: string;                         // Stable hash for dedup/grouping.
  source?: "rule" | "ai";                       // Which detector emitted it.
  cause_confidence?: "observed" | "inferred";
  priority_score?: number;
  // `evidence` is an array of small inline objects, each a key/value pair
  // (with optional threshold+status). Shown in the watchdog drawer UI.
  evidence?: Array<{
    label: string;
    value: string;
    threshold?: string;
    status?: string;
  }>;
  investigation_steps?: string[];
  debug_commands?: string[];
  ts: string;                                   // ISO-8601.
  snapshot_id: string;                          // Links to a pipeline snapshot.
}

/**
 * Aggregated watchdog status.
 * Produced by: `/api/watchdog/status`.
 * Consumed by: hooks/WatchdogContext.tsx (shared across TopBar + Monitoring).
 *
 * `Record<string, number>` is an index signature: "any string key maps to a
 * number". The backend returns severity/category maps with dynamic keys.
 */
export interface WatchdogStatus {
  enabled: boolean;
  interval_sec: number;
  last_run: number;
  last_run_ago_sec: number | null;
  run_count: number;
  total_findings_emitted: number;
  total_findings: number;
  unique_incidents?: number;
  repeating_incidents?: number;
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
  top_incidents?: Array<{
    fingerprint: string;
    severity: string;
    category: string;
    title: string;
    owner: string;
    count: number;
    first_seen_ts: string;
    last_seen_ts: string;
    latest: WatchdogFinding;       // Embeds the full latest finding.
  }>;
}

// =============================================================================
// Test runner — drives the pytest-in-browser button
// =============================================================================

/**
 * Result of a single pytest test, surfaced to the UI by services/test_runner.py.
 * Consumed by: hooks/useTests.ts -> components/tests/TestDrawer.tsx.
 */
export interface TestResult {
  name: string;
  node_id: string;
  file: string;
  // Pytest outcomes. Union forces exhaustive handling in switch statements.
  outcome: "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  message?: string;                  // Stack trace / assertion diff if failed.
}

/**
 * Aggregate status of a test run (or the idle state between runs).
 */
export interface TestStatus {
  status: "idle" | "running" | "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  progress: number;                   // 0..1.
  elapsed_sec: number;
  results: TestResult[];              // Per-test details (see above).
}

// =============================================================================
// Settings Console
// =============================================================================

/**
 * One tunable's metadata, returned by `GET /api/settings/schema`.
 * Mirrors `road_safety.settings_spec.SettingSpec`.
 */
export type SettingType = "float" | "int" | "bool" | "str" | "enum";
export type Mutability = "hot_apply" | "warm_reload" | "restart_required" | "read_only";

export interface SettingSpec {
  key: string;
  default: number | string | boolean;
  type: SettingType;
  category: string;
  mutability: Mutability;
  description: string;
  min: number | null;
  max: number | null;
  step: number | null;
  enum: string[] | null;
  requires_privacy_confirm: boolean;
}

export interface SettingsSchema {
  schema_version: number;
  categories: string[];
  settings: SettingSpec[];
}

export interface EffectiveSettings {
  schema_version: number;
  values: Record<string, number | string | boolean>;
  revision_hash: string;
  revision_no: number;
}

export interface SettingsTemplate {
  id: string;
  name: string;
  description: string;
  system: boolean;
  soft_deleted_at: number | null;
  created_at: number;
  updated_at: number;
  payload: Record<string, number | string | boolean>;
  latest_revision_no: number;
  payload_hash: string;
}

export interface ApplyResultPayload {
  ok: boolean;
  applied_now: string[];
  pending_restart: string[];
  warnings: string[];
  revision_hash_before: string;
  revision_hash_after: string;
  revision_no: number;
  audit_id?: string | null;
  template_id?: string;
}

export interface ValidationErrorBody {
  errors: Array<{ key: string; reason: string }>;
}

export interface WindowStats {
  window_start_ts: number;
  window_end_ts: number;
  duration_sec: number;
  sample_size: number;
  event_rate_per_min: number;
  severity_counts: Record<string, number>;
  severity_ratios: Record<string, number>;
  confidence_p50: number | null;
  confidence_p95: number | null;
  ttc_p50: number | null;
  ttc_p95: number | null;
  distance_p50_m: number | null;
  distance_p95_m: number | null;
  scene_distribution: Record<string, number>;
  quality_distribution: Record<string, number>;
  fp_rate: number | null;
  fp_rate_source: "feedback" | "proxy" | "insufficient";
  actual_fps_p50: number | null;
  actual_fps_p95: number | null;
  frames_dropped_ratio_p95: number | null;
  cpu_p50: number | null;
  cpu_p95: number | null;
  memory_p95: number | null;
  llm_cost_usd_per_min: number | null;
  llm_tokens_per_min: number | null;
  llm_latency_p95_ms: number | null;
  llm_skip_rate: number | null;
  llm_calls: number;
  ops_samples: number;
}

export type ConfidenceTier = "high" | "medium" | "low" | "insufficient";

export interface ImpactReport {
  audit_id: string;
  change_ts: number;
  actor_label: string;
  before: Record<string, number | string | boolean>;
  after: Record<string, number | string | boolean>;
  changed_keys: string[];
  baseline: WindowStats | null;
  after_window: WindowStats | null;
  deltas: Record<string, number>;
  confidence_tier: ConfidenceTier;
  confidence_reasons: string[];
  immediate_metrics: string[];
  lagging_metrics: string[];
  state: "monitoring" | "monitoring_unattended" | "archived";
  warnings: string[];
  last_good: Record<string, number | string | boolean>;
  narrative: string | null;
  recommendation: "keep" | "revert" | "monitor" | null;
}
