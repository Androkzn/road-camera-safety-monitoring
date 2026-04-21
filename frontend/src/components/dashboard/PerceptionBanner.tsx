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

interface PerceptionBannerProps {
  perception: PerceptionState | null;
}

export function PerceptionBannerRow({ perception }: PerceptionBannerProps) {
  const state = perception?.state ?? "nominal";
  const degraded = state !== "nominal";

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
    <div className={`${styles.banner} ${degraded ? styles.degraded : ""}`}>
      <span className={styles.lbl}>Perception</span>
      <span className={styles.st}>{state}</span>
      <span className={styles.reason}>{perception?.reason ?? "warmup"}</span>
      <span className={styles.metrics}>{metrics.join(" · ")}</span>
    </div>
  );
}

interface SceneBannerProps {
  scene: SceneContext | null;
}

export function SceneBannerRow({ scene }: SceneBannerProps) {
  const metrics: string[] = [];
  if (scene?.speed_proxy_mps != null)
    metrics.push(`~${Number(scene.speed_proxy_mps).toFixed(1)} m/s`);
  if (scene?.pedestrian_rate_per_min != null)
    metrics.push(`ped ${Number(scene.pedestrian_rate_per_min).toFixed(1)}/min`);
  if (scene?.thresholds)
    metrics.push(`TTC≤${scene.thresholds.ttc_high_sec}s`);

  return (
    <div className={styles.banner} style={{ borderTop: "none" }}>
      <span className={styles.lbl}>Scene</span>
      <span className={styles.st}>{scene?.label ?? "unknown"}</span>
      <span className={styles.reason}>{scene?.reason ?? "—"}</span>
      <span className={styles.metrics}>{metrics.join(" · ")}</span>
    </div>
  );
}

interface DriftBannerProps {
  drift: DriftReport | null;
  onRefresh: () => void;
}

export function DriftBannerRow({ drift, onRefresh }: DriftBannerProps) {
  const alertTriggered = drift?.alert_triggered ?? false;

  let stateText = "—";
  let reasonText = "no labelled feedback yet";
  let metricsText = "";

  if (drift?.window_size) {
    stateText = drift.precision != null ? `P=${Number(drift.precision).toFixed(2)}` : "—";
    reasonText = drift.trend ? `trend: ${drift.trend}` : "";
    metricsText = `n=${drift.window_size} · TP=${drift.true_positives} · FP=${drift.false_positives}`;
  }

  return (
    <div
      className={`${styles.banner} ${alertTriggered ? styles.degraded : ""}`}
      style={{ borderTop: "none", cursor: "pointer" }}
      title="Click to refresh drift report"
      onClick={onRefresh}
    >
      <span className={styles.lbl}>Drift</span>
      <span className={styles.st}>{stateText}</span>
      <span className={styles.reason}>{reasonText}</span>
      <span className={styles.metrics}>{metricsText}</span>
    </div>
  );
}
