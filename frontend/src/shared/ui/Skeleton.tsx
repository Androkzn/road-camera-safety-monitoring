/**
 * Skeleton — content-loading shimmer placeholder. Pass width/height as
 * numbers (px) or strings (any CSS length).
 *
 * Usage:
 *   <Skeleton width="100%" height={20} />
 *   <Skeleton circle width={32} height={32} />
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Used as a pre-data
 *   placeholder anywhere a card or list is loading on AdminPage,
 *   DashboardPage, MonitoringPage, SettingsPage and ValidationPage.
 * UI element: shimmering grey placeholder bar (or circle) that occupies
 *   the eventual size of the content while it loads.
 */
import type { CSSProperties } from "react";

import { cx } from "../lib/cx";
import styles from "./Skeleton.module.css";

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  circle?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 14, circle, className, style }: SkeletonProps) {
  const cls = cx(styles.skeleton, className);
  return (
    <span
      className={cls}
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius: circle ? "50%" : undefined,
        ...style,
      }}
    />
  );
}
