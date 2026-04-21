/**
 * TopBar — persistent header strip rendered on every page.
 *
 * Pure presentational component: takes a connection flag, an optional
 * unread-error count for the Monitoring link, and any children to slot
 * into the right side. Pages own the data sources and pass them in,
 * which keeps `shared/` decoupled from any feature.
 *
 * --- Backend coupling ---
 * None. TopBar never calls the backend — it only renders props. Counts
 * come from context via PageChrome; connection status comes from the
 * page's own `useLiveStatus()` hook and is forwarded as the `connected`
 * prop.
 *
 * --- Child components hosted ---
 * - `<Link>` from react-router for brand + nav entries.
 * - `<Pill>` + `<Dot>` from `shared/ui` for the live-status indicator.
 * - `children` slot (right side, after the status pill): PageChrome
 *   forwards the TestBadge here.
 *
 * --- UI mapping ---
 * Used on: All pages (global layout). Rendered (via PageChrome) at the
 *   top of AdminPage, DashboardPage, MonitoringPage, SettingsPage and
 *   ValidationPage.
 * UI element: the top navigation bar shown on every page — brand logo,
 *   nav links (Admin, Dashboard, Monitoring, Validation, Settings) with
 *   red bubbles for unread errors / drift, and a live-status pill on
 *   the right.
 */
import { Link, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import { Pill, Dot } from "../ui";

import styles from "./TopBar.module.css";

interface TopBarProps {
  /** Kept for backwards-compat with callers; not rendered (see CLAUDE.md). */
  sourceName?: string;
  connected?: boolean;
  /** Unread monitoring errors — drives the red bubble on the Monitoring link. */
  errorCount?: number;
  /** Drift findings from the shadow validator — drives the red bubble on
   *  the Validation link. Covers false positives, class mismatches, and
   *  shadow-only detections (false negatives). */
  driftCount?: number;
  children?: ReactNode;
}

/**
 * TopBar — nav + live-connection pill. Pure presentational.
 *
 * What it renders: a `<header>` flex row containing (in order) the
 * brand Link, the primary `<nav>` with five route Links, a flex spacer,
 * the live-status Pill, and any `children` (right-side slot — currently
 * the TestBadge from PageChrome).
 *
 * Props: see `TopBarProps` above. `connected` is tri-state (true /
 * false / undefined); `errorCount` and `driftCount` default to `0` and
 * suppress their red bubbles when zero.
 *
 * Active-link highlighting: `useLocation()` reads the current URL from
 * react-router context and `styles.active` is applied when pathname
 * matches — no runtime effect, just a className toggle.
 */
export function TopBar({ connected, errorCount = 0, driftCount = 0, children }: TopBarProps) {
  const { pathname } = useLocation();

  // Tri-state: connected / disconnected / still-connecting (undefined).
  const statusVariant = connected === true ? "ok" : connected === false ? "bad" : "wait";
  const statusLabel =
    connected === true ? "live" : connected === false ? "disconnected" : "connecting…";

  return (
    <header className={styles.topbar}>
      <Link to="/" className={styles.brand}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4l2 2" />
        </svg>
        Road Safety
      </Link>
      <nav className={styles.nav}>
        <Link to="/" className={pathname === "/" ? styles.active : ""}>
          Admin
        </Link>
        <Link to="/dashboard" className={pathname === "/dashboard" ? styles.active : ""}>
          Dashboard
        </Link>
        <Link
          to="/monitoring"
          className={`${styles.monLink} ${pathname === "/monitoring" ? styles.active : ""}`}
        >
          Monitoring
          {errorCount > 0 && <span className={styles.errorBubble}>{errorCount}</span>}
        </Link>
        <Link
          to="/validation"
          className={`${styles.monLink} ${pathname === "/validation" ? styles.active : ""}`}
        >
          Validation
          {driftCount > 0 && (
            <span
              className={`${styles.errorBubble} ${styles.driftBubble}`}
              title={`${driftCount} drift finding${driftCount === 1 ? "" : "s"} — second model disagrees`}
            >
              {driftCount}
            </span>
          )}
        </Link>
        <Link to="/settings" className={pathname === "/settings" ? styles.active : ""}>
          Settings
        </Link>
      </nav>
      {/* Flex spacer — pushes the status pill + children to the far right. */}
      <span className={styles.spacer} />
      <Pill>
        <Dot variant={statusVariant} />
        <span>{statusLabel}</span>
      </Pill>
      {/* Right-side slot — PageChrome forwards TestBadge here. */}
      {children}
    </header>
  );
}
