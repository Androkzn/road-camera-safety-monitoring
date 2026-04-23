/**
 * Skeleton — content-loading shimmer placeholder. Pass width/height as
 * numbers (px) or strings (any CSS length).
 *
 * Purpose: reserve space with a shimmer while async data is in flight so
 *   the layout does not jump when the real content renders.
 * Visual role: low-emphasis greyscale bar/circle with a CSS animation
 *   driven by `Skeleton.module.css` (no JS timers).
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

// Props:
//   width/height — number (px) or CSS string (e.g. "100%"). Default fills
//                  the parent width with a 14 px text-line height.
//   circle       — when true, forces border-radius:50% for avatar stubs.
//   className    — merged after module styles so callers can override.
//   style        — inline overrides applied last (wins over all else).
interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  circle?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders a single shimmering placeholder span.
 *
 * a11y: marked `aria-hidden="true"` — screen readers should announce the
 *   surrounding "loading" status (e.g. a Spinner with role="status"), not
 *   the decorative placeholder itself.
 * Variants: rectangular bar (default) or circle when `circle` is set.
 */
export function Skeleton({ width = "100%", height = 14, circle, className, style }: SkeletonProps) {
  // Merge module-scoped shimmer class with any caller-provided className.
  const cls = cx(styles.skeleton, className);
  return (
    <span
      className={cls}
      aria-hidden="true"
      style={{
        width,
        height,
        // circle overrides border-radius; otherwise inherit the CSS module default.
        borderRadius: circle ? "50%" : undefined,
        // caller `style` spread last so it can override width/height/radius.
        ...style,
      }}
    />
  );
}
