/**
 * Spinner — small CSS-only loading spinner. Sizes are in pixels for
 * predictable inline alignment alongside text.
 *
 * Purpose: indicate pending async work (route transition, button action,
 *   query refetch) without blocking layout.
 * Visual role: border-based rotating ring, animation defined in
 *   `Spinner.module.css`; no SVG/JS timers needed.
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Shown by the route loading
 *   fallback (RouteFallback) on every page transition, and inline next
 *   to async buttons across AdminPage, DashboardPage, MonitoringPage and
 *   SettingsPage.
 * UI element: small spinning circle indicator used to show that
 *   something is loading.
 */
import type { CSSProperties } from "react";

import { cx } from "../lib/cx";
import styles from "./Spinner.module.css";

// Props:
//   size      — outer diameter in px (default 16, tuned to fit inline with text).
//   thickness — ring stroke width in px; maps to CSS `border-width`.
//   className — extra class merged after the module class for overrides.
//   style     — inline overrides applied last.
//   ariaLabel — screen-reader label announced alongside role="status".
interface SpinnerProps {
  size?: number;
  thickness?: number;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

/**
 * Renders a spinning ring.
 *
 * a11y: `role="status"` marks it as a live region and `aria-label`
 *   ("Loading" by default) gives assistive tech a readable description —
 *   override `ariaLabel` for more specific contexts (e.g. "Saving…").
 * Animation: pure CSS keyframes from the module stylesheet — no React
 *   state or rAF, so it is cheap to mount many in parallel.
 */
export function Spinner({
  size = 16,
  thickness = 2,
  className,
  style,
  ariaLabel = "Loading",
}: SpinnerProps) {
  // Combine base module class with any caller override.
  const cls = cx(styles.spinner, className);
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cls}
      // width/height keep the ring square; borderWidth controls stroke.
      style={{ width: size, height: size, borderWidth: thickness, ...style }}
    />
  );
}
