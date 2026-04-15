export interface Enrichment {
  plate_hash?: string;
  readability?: string;
  vehicle_color?: string;
  vehicle_type?: string;
}

export interface SafetyEvent {
  event_id: string;
  vehicle_id?: string;
  road_id?: string;
  driver_id?: string;
  video_id?: string;
  timestamp_sec?: number;
  wall_time?: string;
  event_type: string;
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

export interface PerceptionState {
  _meta: "perception_state";
  state: string;
  reason: string;
  luminance?: number;
  sharpness?: number;
  avg_confidence?: number;
  samples?: number;
}

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

export interface DriftReport {
  window_size: number;
  true_positives: number;
  false_positives: number;
  precision?: number;
  trend?: string;
  alert_triggered?: boolean;
}

export interface DetectionObject {
  cls: string;
  conf: number;
  track_id?: number;
  bbox: [number, number, number, number];
}

export interface DetectionSnapshot {
  ts: number;
  detections: number;
  persons: number;
  vehicles: number;
  interactions: number;
  objects: DetectionObject[];
}

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

export interface TestResult {
  name: string;
  node_id: string;
  file: string;
  outcome: "passed" | "failed" | "error" | "skipped";
  duration_ms: number;
  message?: string;
}

export interface TestStatus {
  status: "idle" | "running" | "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  progress: number;
  elapsed_sec: number;
  results: TestResult[];
}
