/**
 * PerceptionBanner — three stacked status banners exported as three
 * separate small components:
 *   - PerceptionBannerRow : camera-health/perception state (lum, sharpness...)
 *   - SceneBannerRow      : scene classifier output (urban/highway/parking...)
 *   - DriftBannerRow      : model-drift snapshot, clickable to refresh
 *
 * Rendered by: pages/DashboardPage.tsx, one after another.
 *
 * Props:
 *   PerceptionBannerRow  { perception: PerceptionState | null }
 *   SceneBannerRow       { scene: SceneContext | null }
 *   DriftBannerRow       { drift: DriftReport | null, onRefresh: () => void }
 *   The parent (DashboardPage) owns the data and refresh handler.
 *
 * React concepts first-taught in this file:
 *   - Multiple components exported from one file
 *   - `| null` prop types + the `?.` optional-chaining pattern for rendering
 *   - The `??` nullish-coalescing operator for fallbacks in JSX
 *   - Building a display string array imperatively *before* JSX (not inside it)
 *   - Conditional className composition (`${styles.banner} ${cond ? styles.X : ""}`)
 *   - Inline-style prop (`style={{ borderTop: "none" }}`) — when to use it
 *   - Click-to-refresh pattern via an `onRefresh` callback prop
 *   - `type` import (types-only import, erased at build time)
 */

// --- Imports ---
// TEACH: `import type { ... }` imports TypeScript types only. At runtime
// there is nothing here — the import is stripped by the compiler. Use this
// for anything that only appears in type positions (props, return types).
import type { PerceptionState, SceneContext, DriftReport } from "../../types";
// TEACH: Component-scoped styles, same CSS-Modules pattern as SummaryTiles.
import styles from "./PerceptionBanner.module.css";

// --- Types ---
// TEACH: Interface for the first component's props. Note `| null` — the
// parent can pass `null` while the SSE stream is still warming up, and we
// handle that case with optional chaining below.
interface PerceptionBannerProps {
  perception: PerceptionState | null;
}

// --- Render: PerceptionBannerRow ---
export function PerceptionBannerRow({ perception }: PerceptionBannerProps) {
  // TEACH: Optional chaining `?.` short-circuits if `perception` is null or
  // undefined. The `??` nullish-coalescing operator then supplies a default.
  // Net effect: state = perception?.state if present, else "nominal".
  const state = perception?.state ?? "nominal";
  const degraded = state !== "nominal";

  // TEACH: Build a display-string array *before* JSX. Mixing this much
  // conditional logic into the JSX itself would be unreadable; doing it
  // imperatively first is idiomatic React.
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
    // TEACH: Conditional className — when `degraded` is true we tack on
    // `styles.degraded` which applies red accents; otherwise empty string.
    <div className={`${styles.banner} ${degraded ? styles.degraded : ""}`}>
      <span className={styles.lbl}>Perception</span>
      <span className={styles.st}>{state}</span>
      {/* TEACH: Fallback via `??` straight inside JSX. */}
      <span className={styles.reason}>{perception?.reason ?? "warmup"}</span>
      {/* TEACH: `.join(" · ")` stringifies the metrics array for display. */}
      <span className={styles.metrics}>{metrics.join(" · ")}</span>
    </div>
  );
}

// --- Types: SceneBannerRow ---
interface SceneBannerProps {
  scene: SceneContext | null;
}

// --- Render: SceneBannerRow ---
export function SceneBannerRow({ scene }: SceneBannerProps) {
  // Same metric-building pattern as above, with scene-specific fields.
  const metrics: string[] = [];
  if (scene?.speed_proxy_mps != null)
    metrics.push(`~${Number(scene.speed_proxy_mps).toFixed(1)} m/s`);
  if (scene?.pedestrian_rate_per_min != null)
    metrics.push(`ped ${Number(scene.pedestrian_rate_per_min).toFixed(1)}/min`);
  if (scene?.thresholds)
    metrics.push(`TTC≤${scene.thresholds.ttc_high_sec}s`);

  return (
    // TEACH: Inline `style={{ ... }}` — note the double braces. Outer `{}`
    // is JSX "insert JS expression", inner `{}` is the JS object literal.
    // We use inline style here to override `border-top` for stacked banners;
    // generally prefer CSS Modules, and only use inline-style for truly
    // dynamic values or one-off layout tweaks like this one.
    <div className={styles.banner} style={{ borderTop: "none" }}>
      <span className={styles.lbl}>Scene</span>
      <span className={styles.st}>{scene?.label ?? "unknown"}</span>
      <span className={styles.reason}>{scene?.reason ?? "—"}</span>
      <span className={styles.metrics}>{metrics.join(" · ")}</span>
    </div>
  );
}

// --- Types: DriftBannerRow ---
// TEACH: Callback prop pattern. `onRefresh: () => void` declares a function
// the parent passes in; the child calls it on click. This is how child
// components notify parents of user intent without knowing what the parent
// will do (inversion of control).
interface DriftBannerProps {
  drift: DriftReport | null;
  onRefresh: () => void;
}

// --- Render: DriftBannerRow ---
export function DriftBannerRow({ drift, onRefresh }: DriftBannerProps) {
  const alertTriggered = drift?.alert_triggered ?? false;

  // TEACH: Build display strings with `let` + conditional assignment. This
  // is plain JS — nothing React-specific. The compiler will narrow types
  // through the `if` blocks.
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
      // TEACH: Same conditional-class pattern; when alerting, turn banner red.
      className={`${styles.banner} ${alertTriggered ? styles.degraded : ""}`}
      style={{ borderTop: "none", cursor: "pointer" }}
      title="Click to refresh drift report"
      // TEACH: Passing the callback directly (no inline arrow). React calls
      // `onRefresh(event)` — we ignore the event. Equivalent to
      // `onClick={(e) => onRefresh()}` but avoids creating a new function
      // per render.
      onClick={onRefresh}
    >
      <span className={styles.lbl}>Drift</span>
      <span className={styles.st}>{stateText}</span>
      <span className={styles.reason}>{reasonText}</span>
      <span className={styles.metrics}>{metricsText}</span>
    </div>
  );
}
