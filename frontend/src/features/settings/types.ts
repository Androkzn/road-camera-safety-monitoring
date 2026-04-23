/**
 * Settings Console types — feature-local backend contracts.
 *
 * Cross-feature types stay in `shared/types/common.ts`; everything in
 * here is consumed only by the Settings page.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: No direct UI — TypeScript type definitions used by the
 *   SettingsPage components, hooks and api wrappers.
 */

/** SettingType — primitive kind of a tunable; drives which Tunable input
 *  is rendered (slider vs number vs toggle vs select). */
export type SettingType = "float" | "int" | "bool" | "str" | "enum";
/** Mutability — how the backend handles an accepted change:
 *  - hot_apply: takes effect immediately in-process;
 *  - warm_reload: takes effect on next perception-loop tick;
 *  - restart_required: staged in pending_restart until the server restarts;
 *  - read_only: surfaced for visibility but not editable. */
export type Mutability = "hot_apply" | "warm_reload" | "restart_required" | "read_only";

/** SettingSpec — one row from GET /api/settings/schema; everything the UI
 *  needs to render a Tunable row (bounds, step, enum choices, category,
 *  and the privacy-confirmation flag for sensitive tunables). */
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

/** SettingsSchema — full GET /api/settings/schema response; consumed by
 *  useSettings and grouped into categories by SettingsPage. */
export interface SettingsSchema {
  schema_version: number;
  categories: string[];
  settings: SettingSpec[];
}

/** EffectiveSettings — GET /api/settings/effective response; current values
 *  plus `revision_hash` used for optimistic concurrency on apply. */
export interface EffectiveSettings {
  schema_version: number;
  values: Record<string, number | string | boolean>;
  revision_hash: string;
  revision_no: number;
}

/** ApplyResultPayload — POST /api/settings/apply response body.
 *  `applied_now` lists hot_apply/warm_reload keys that took effect;
 *  `pending_restart` lists restart_required keys that are staged;
 *  `audit_id` links to the audit-log entry for this change. */
export interface ApplyResultPayload {
  ok: boolean;
  applied_now: string[];
  pending_restart: string[];
  warnings: string[];
  revision_hash_before: string;
  revision_hash_after: string;
  revision_no: number;
  audit_id?: string | null;
}

/** ValidationErrorBody — 422 body from /api/settings/validate and
 *  /api/settings/apply. Rendered by the ErrorList / per-row errorByKey
 *  map on SettingsPage. */
export interface ValidationErrorBody {
  errors: Array<{ key: string; reason: string }>;
}

/** WindowStats — server-computed stats for a single time window (either
 *  "baseline" pre-change or "after_window" post-change) inside an
 *  ImpactReport. Fields mostly map 1:1 to keys in METRIC_LABELS.
 *  Nullable percentiles mean "not enough samples to compute". */
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

/** ConfidenceTier — how confident the impact engine is that the observed
 *  deltas are attributable to the change (vs scene drift / sample noise). */
export type ConfidenceTier = "high" | "medium" | "low" | "insufficient";

/** ImpactReport — GET /api/settings/impact response. Drives the
 *  right-column ImpactCard: before/after WindowStats, per-metric deltas,
 *  severity bars, and a recommendation chip (keep / revert / monitor). */
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

/** DraftValue — value held in the draft state for a single tunable.
 *  Mirrors the union of types a SettingSpec can produce; narrowed to the
 *  concrete type by Tunable based on SettingSpec.type. */
export type DraftValue = number | string | boolean;
