/**
 * PerceptionBanner.tsx — three narrow info banners shown in order on the
 * Dashboard: Perception, Scene, and Drift.
 *
 * What it does:
 *   Exports three row components (`PerceptionBannerRow`, `SceneBannerRow`,
 *   `DriftBannerRow`). Each row shows a label, a primary state, a short
 *   reason string, and a trailing metrics line joined by middle dots.
 *   The Perception row turns red when the state is not "nominal"; the
 *   Drift row turns red when an alert is triggered and is clickable to
 *   trigger a refresh.
 *
 * Purpose:
 *   Keeps the operator aware of model/environment health (blur, luminance,
 *   confidence), the traffic scene context (speed, pedestrian rate, TTC
 *   thresholds), and precision drift over user feedback.
 *
 * How it works:
 *   - Each component takes a single prop: a data object (or `null` when
 *     the backend has not responded yet). Optional chaining (`perception?.
 *     luminance`) returns undefined instead of throwing on null.
 *   - A local `metrics` string array is populated with short chunks ("lum
 *     127", "sharp 42", etc.) and then joined with " · " for display. This
 *     is a tidy way to conditionally include fields.
 *   - `DriftBannerRow` accepts an `onRefresh` callback so clicking the row
 *     tells the parent to re-fetch the drift report.
 *   - Union types like `PerceptionState | null` mean the value is either
 *     that shape or null — TS makes us handle both.
 *
 * Connects to:
 *   - Backend: perception comes from SSE (`/api/live/events/stream`) or
 *     polled `/api/live/status`; scene from `GET /api/live/scene`; drift
 *     from `GET /api/drift` (refresh via onRefresh).
 *   - UI: rendered by `pages/DashboardPage.tsx` beneath `<SummaryTiles>`
 *     and above the event filter bar.
 */
import type { PerceptionState, SceneContext, DriftReport } from "../../types";
import styles from "./PerceptionBanner.module.css";

// Props for the Perception row. `| null` means "the full object or null
// while the initial fetch is pending".
interface PerceptionBannerProps {
  perception: PerceptionState | null;
}

// Renders the top "Perception" banner row on the Dashboard, sitting directly
// below the SummaryTiles. Turns red when the perception state is not "nominal".
export function PerceptionBannerRow({ perception }: PerceptionBannerProps) {
  // `?.` = optional chaining: reads `.state` if perception isn't null, else undefined.
  // `??` = nullish coalescing: fall back to "nominal" when undefined/null.
  const state = perception?.state ?? "nominal";
  // Drives the red "degraded" styling when state is anything other than nominal.
  const degraded = state !== "nominal";

  // Build a compact "chip" list of metrics. Only push pieces that are present,
  // so we can safely join with " · " later without showing empty segments.
  const metrics: string[] = [];
  if (perception?.luminance != null)
    metrics.push(`lum ${Number(perception.luminance).toFixed(0)}`);
  if (perception?.sharpness != null)
    metrics.push(`sharp ${Number(perception.sharpness).toFixed(0)}`);
  if (perception?.avg_confidence != null)
    metrics.push(`avg-conf ${Number(perception.avg_confidence).toFixed(2)}`);
  if (perception?.samples != null)
    metrics.push(`n=${perception.samples}`);

  return (
    // One horizontal banner row — label, state, reason, metrics; red background when degraded
    <div className={`${styles.banner} ${degraded ? styles.degraded : ""}`}>
      {/* Left-most "Perception" label */}
      <span className={styles.lbl}>Perception</span>
      {/* Primary state text, e.g. "nominal" or "degraded" */}
      <span className={styles.st}>{state}</span>
      {/* Short reason string from the backend (e.g. "warmup", "low-luminance") */}
      <span className={styles.reason}>{perception?.reason ?? "warmup"}</span>
      {/* Trailing metrics joined by middle-dot separators */}
      <span className={styles.metrics}>{metrics.join(" · ")}</span>
    </div>
  );
}

// Props for the Scene row.
interface SceneBannerProps {
  scene: SceneContext | null;
}

// Renders the middle "Scene" banner row on the Dashboard, directly below the
// Perception banner. Always neutral styling — informational only.
export function SceneBannerRow({ scene }: SceneBannerProps) {
  // Same metric-chip building pattern: push only present pieces.
  const metrics: string[] = [];
  if (scene?.speed_proxy_mps != null)
    metrics.push(`~${Number(scene.speed_proxy_mps).toFixed(1)} m/s`);
  if (scene?.pedestrian_rate_per_min != null)
    metrics.push(`ped ${Number(scene.pedestrian_rate_per_min).toFixed(1)}/min`);
  if (scene?.thresholds)
    metrics.push(`TTC≤${scene.thresholds.ttc_high_sec}s`);

  return (
    // Scene row — styled inline with `borderTop: "none"` to sit flush under the Perception row
    <div className={styles.banner} style={{ borderTop: "none" }}>
      {/* "Scene" label on the left */}
      <span className={styles.lbl}>Scene</span>
      {/* Scene label, e.g. "street_level" or "unknown" */}
      <span className={styles.st}>{scene?.label ?? "unknown"}</span>
      {/* Human reason string, falls back to em-dash */}
      <span className={styles.reason}>{scene?.reason ?? "—"}</span>
      {/* Scene metrics chips (speed, pedestrian rate, TTC threshold) */}
      <span className={styles.metrics}>{metrics.join(" · ")}</span>
    </div>
  );
}

// Props for the Drift row. `onRefresh` is called when the banner is clicked.
interface DriftBannerProps {
  drift: DriftReport | null;
  onRefresh: () => void;
}

// Renders the bottom "Drift" banner row on the Dashboard. Clickable — the
// whole banner acts as a refresh button for the drift report. Turns red when
// a drift alert is currently triggered.
export function DriftBannerRow({ drift, onRefresh }: DriftBannerProps) {
  // True when backend reports a drift alert — drives the red "degraded" look.
  const alertTriggered = drift?.alert_triggered ?? false;

  // Local display strings. Defaults cover the "no labelled feedback yet" case.
  let stateText = "—";
  let reasonText = "no labelled feedback yet";
  let metricsText = "";

  // Only overwrite defaults when we have a non-empty evaluation window.
  if (drift?.window_size) {
    stateText = drift.precision != null ? `P=${Number(drift.precision).toFixed(2)}` : "—";
    reasonText = drift.trend ? `trend: ${drift.trend}` : "";
    metricsText = `n=${drift.window_size} · TP=${drift.true_positives} · FP=${drift.false_positives}`;
  }

  return (
    // Drift row — clickable banner; cursor pointer + tooltip communicate that clicking refreshes
    <div
      className={`${styles.banner} ${alertTriggered ? styles.degraded : ""}`}
      style={{ borderTop: "none", cursor: "pointer" }}
      title="Click to refresh drift report"
      onClick={onRefresh}
    >
      {/* "Drift" label on the left */}
      <span className={styles.lbl}>Drift</span>
      {/* Precision state, e.g. "P=0.87" */}
      <span className={styles.st}>{stateText}</span>
      {/* Trend reason, e.g. "trend: falling" */}
      <span className={styles.reason}>{reasonText}</span>
      {/* Sample counts on the right: window size, true positives, false positives */}
      <span className={styles.metrics}>{metricsText}</span>
    </div>
  );
}
