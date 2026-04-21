/**
 * Spinner — small CSS-only loading spinner. Sizes are in pixels for
 * predictable inline alignment alongside text.
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

interface SpinnerProps {
  size?: number;
  thickness?: number;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

export function Spinner({
  size = 16,
  thickness = 2,
  className,
  style,
  ariaLabel = "Loading",
}: SpinnerProps) {
  const cls = cx(styles.spinner, className);
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cls}
      style={{ width: size, height: size, borderWidth: thickness, ...style }}
    />
  );
}
