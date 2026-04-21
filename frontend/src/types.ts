/**
 * types.ts — shared TypeScript type catalog for the whole frontend.
 *
 * What it does:
 *   Defines the "shapes" (object structures) that flow between the backend
 *   and the React UI. Every file that fetches JSON from the API or receives
 *   Server-Sent Events imports type names from here so the compiler can
 *   catch typos and missing fields at build time.
 *
 * Purpose:
 *   One central source of truth for the data model. If the backend changes a
 *   field name, updating it in this file lights up every usage site that
 *   needs to change too.
 *
 * How it works:
 *   - `export interface X { ... }` declares a named object shape; other
 *     files write `import type { X } from "../types"` to reference it.
 *   - Optional fields are marked with `?` (e.g. `confidence?: number`) —
 *     the value can be missing.
 *   - Union types like `"high" | "medium" | "low"` mean the value must be
 *     exactly one of those strings (a TypeScript "string literal union").
 *   - `Record<K, V>` is a shortcut for an object whose keys are of type K
 *     and values are of type V.
 *   - Tuple types like `[number, number, number, number]` are fixed-length
 *     arrays with known element types (used here for bounding boxes).
 *   - These types MIRROR JSON shapes produced by road_safety/server.py —
 *     they are descriptive only, not enforced at runtime.
 *
 * Main type categories defined here:
 *   - Events & enrichment:   SafetyEvent, Enrichment
 *   - Live perception/status: PerceptionState, LiveStatus
 *   - Scene context:          SceneContext
 *   - Drift / model health:   DriftReport
 *   - Detection stream:       DetectionObject, DetectionSnapshot
 *   - Admin health:           HealthData
 *   - Watchdog incidents:     WatchdogFinding, WatchdogStatus
 *   - Test runner:            TestResult, TestStatus
 *
 * Connects to:
 *   - Backend: every API endpoint in road_safety/server.py that returns JSON
 *     (/api/live/status, /api/live/scene, /api/drift, /api/admin/health,
 *     /api/live/events, /api/watchdog*, /api/tests/*, plus the SSE streams
 *     /stream/events and /admin/detections).
 *   - UI: imported by frontend/src/lib/api.ts, every page, and most hooks.
 */
// Optional per-event metadata added by the enrichment stage (plate hash,
// vehicle color/type). Nested inside SafetyEvent; shown by components/events.
export interface Enrichment {
  plate_hash?: string;
  readability?: string;
  vehicle_color?: string;
  vehicle_type?: string;
}

// A single safety finding emitted by the backend pipeline (near-miss, red-light
// run, etc.). Sent over /stream/events SSE; rendered by EventCard and
// AdminEventCard (frontend/src/components/events/).
export interface SafetyEvent {
  event_id: string;
  vehicle_id?: string;
  road_id?: string;
  driver_id?: string;
  video_id?: string;
  timestamp_sec?: number;
  wall_time?: string;
  event_type: string;
  // Union: risk_level is exactly one of these three strings (used to colour
  // the event card and drive the dashboard risk filter).
  risk_level: "high" | "medium" | "low";
  confidence?: number;
  objects?: string[];
  track_ids?: number[];
  episode_duration_sec?: number;
  ttc_sec?: number;
  distance_m?: number;
  distance_px?: number;
  summary?: string;
  narration?: string;
  thumbnail?: string;
  enrichment?: Enrichment;
  enrichment_skipped?: string;
  perception_state?: string;
  _meta?: string;
}

// Snapshot of the vision pipeline's "can-I-see" state (e.g. night, glare,
// blurry). Pushed inside the SSE stream and polled via /api/live/status;
// shown by components/dashboard/PerceptionBannerRow.
export interface PerceptionState {
  // `_meta` is locked to the literal string "perception_state" — the discriminator
  // TypeScript uses to tell this shape apart from other SSE payloads.
  _meta: "perception_state";
  state: string;
  reason: string;
  luminance?: number;
  sharpness?: number;
  avg_confidence?: number;
  samples?: number;
}

// Live pipeline summary returned by /api/live/status; consumed by
// hooks/useLiveStatus.ts and shown in TopBar + dashboard uptime tile.
export interface LiveStatus {
  source: string;
  running: boolean;
  event_count: number;
  frames_read: number;
  frames_processed: number;
  uptime_sec: number;
  started_at: number | null;
  perception?: PerceptionState;
}

// Current scene classification (highway vs urban vs parking, etc.) returned
// by /api/live/scene; consumed by hooks/useScene.ts and SceneBannerRow.
export interface SceneContext {
  label: string;
  confidence?: number;
  speed_proxy_mps?: number;
  pedestrian_rate_per_min?: number;
  reason: string;
  thresholds?: {
    ttc_high_sec: number;
    ttc_med_sec: number;
    dist_high_m: number;
    dist_med_m: number;
  };
}

// Model-health summary from /api/drift (precision trend in the recent window);
// consumed by hooks/useDrift.ts and rendered by DriftBannerRow on the dashboard.
export interface DriftReport {
  window_size: number;
  true_positives: number;
  false_positives: number;
  precision?: number;
  trend?: string;
  alert_triggered?: boolean;
}

// One detected object inside a single frame. The `bbox` tuple is a
// fixed-length [x, y, w, h] — tuple types in TS are arrays with a known length
// and element types. Consumed by DetectionsPanel's frame renderer.
export interface DetectionObject {
  cls: string;
  conf: number;
  track_id?: number;
  bbox: [number, number, number, number];
}

// Per-frame detection summary from the /admin/detections SSE stream; consumed
// by hooks/useDetections.ts and rendered inside components/admin/VideoFeed +
// DetectionsPanel on the admin page.
export interface DetectionSnapshot {
  ts: number;
  detections: number;
  persons: number;
  vehicles: number;
  interactions: number;
  objects: DetectionObject[];
}

// Full admin health blob returned by /api/admin/health (grouped into server /
// pipeline / integrations / perception / scene buckets). Consumed by
// hooks/useAdminHealth.ts and rendered in components/admin/HealthStrip.
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

// A single watchdog finding (one observed problem at one moment). Returned by
// /api/watchdog/recent and /api/watchdog/findings; loaded by WatchdogContext
// and grouped into incidents on pages/MonitoringPage.tsx.
export interface WatchdogFinding {
  // Union: the three severity buckets driving the coloured badges/tiles.
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
  // "rule" = deterministic check, "ai" = LLM-generated hypothesis. Drives the
  // "AI hypothesis" pill on incident cards.
  source?: "rule" | "ai";
  // "observed" = directly measured, "inferred" = guessed from context.
  cause_confidence?: "observed" | "inferred";
  priority_score?: number;
  evidence?: Array<{
    label: string;
    value: string;
    threshold?: string;
    status?: string;
  }>;
  investigation_steps?: string[];
  debug_commands?: string[];
  ts: string;
  snapshot_id: string;
}

// Aggregated watchdog status returned by /api/watchdog (counts per severity /
// category, top repeating incidents). `Record<string, number>` = object whose
// keys are strings and values are numbers. Used in MonitoringPage meta cards.
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
    latest: WatchdogFinding;
  }>;
}

// One pytest result row. Consumed by hooks/useTests.ts and rendered in the
// TestDrawer (components/tests/TestDrawer.tsx) on the dashboard page.
export interface TestResult {
  name: string;
  node_id: string;
  file: string;
  // Union: pytest outcome bucket; drives the row icon/colour in the drawer.
  outcome: "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  message?: string;
}

// Overall test-run status polled from /api/tests/status; shown by TestBadge in
// the TopBar and auto-opens TestDrawer on the dashboard when tests fail.
export interface TestStatus {
  // Union: the four lifecycle states driving the badge colour + drawer logic.
  status: "idle" | "running" | "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  progress: number;
  elapsed_sec: number;
  results: TestResult[];
}
