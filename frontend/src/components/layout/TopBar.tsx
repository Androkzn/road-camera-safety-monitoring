/**
 * TopBar.tsx — persistent site header with brand, nav, and live-stream pill.
 *
 * What it does:
 *   Shows the "Road Safety" logo, the Admin / Dashboard / Monitoring nav
 *   links, a live-status pill ("dashcam_1 • live / connecting / disconnected"),
 *   and an error count bubble on the Monitoring link when watchdog errors
 *   exist. Any extra `children` (e.g. uptime pill, test badge) render to the
 *   right of the status pill.
 *
 * Purpose:
 *   Single header shared by every page — gives operators a consistent place
 *   to switch tabs and read stream health at a glance.
 *
 * How it works:
 *   - Props: `sourceName` (camera/source label), `connected` (true/false/
 *     undefined), `children` (extra widgets injected by the page).
 *   - `useLocation` (react-router) gives the current URL path so the active
 *     nav link can be highlighted.
 *   - `useWatchdogCtx()` reads the shared watchdog status context; the
 *     `error` count is shown as a red bubble. `?.` (optional chaining) safely
 *     returns undefined if any link in the chain is missing.
 *   - Conditional rendering `errorCount > 0 && (<span>…)` shows the bubble
 *     only when there is at least one error.
 *
 * Connects to:
 *   - Backend: indirectly — watchdog counts come from
 *     `WatchdogContext` → `/api/watchdog` and `/api/watchdog/recent`.
 *     Stream connection status is passed down from each page's hook.
 *   - UI: rendered at the top of `pages/AdminPage.tsx`,
 *     `pages/DashboardPage.tsx`, and `pages/MonitoringPage.tsx`.
 */
// `Link` = client-side navigation (no full reload). `useLocation` = hook that returns the current URL.
import { Link, useLocation } from "react-router-dom";
import { Pill, Dot } from "../ui";
import type { ReactNode } from "react";
// Shared React context that holds watchdog status/findings so any component can read them.
import { useWatchdogCtx } from "../../hooks/WatchdogContext";
// CSS Modules — `styles.topbar` resolves to a unique class name scoped to this file.
import styles from "./TopBar.module.css";

// Props: `sourceName` (camera label shown in the pill), `connected` (stream health tri-state:
// true=live, false=disconnected, undefined=connecting), `children` (extra widgets injected by the page, e.g. TestBadge).
interface TopBarProps {
  sourceName?: string;
  connected?: boolean;
  children?: ReactNode;
}

// TopBar — persistent header bar at the top of every page.
// Left: brand/logo. Middle: Admin/Dashboard/Monitoring nav links. Right: source pill + connected dot + watchdog bubble + any children.
export function TopBar({ sourceName = "—", connected, children }: TopBarProps) {
  // `useLocation` gives the current URL; destructure just `pathname` to compare with each nav link.
  const { pathname } = useLocation();
  // Pull watchdog status from context so we can show an error bubble on the Monitoring link.
  const { status: wdStatus } = useWatchdogCtx();

  // Optional chaining (`?.`) safely walks through possibly-undefined objects.
  // Nullish coalescing (`??`) provides 0 when the chain ends in null/undefined.
  const errorCount = wdStatus?.by_severity?.error ?? 0;

  // Pick the colored dot variant: green (ok), red (bad), amber (wait while still connecting).
  const statusVariant = connected === true ? "ok" : connected === false ? "bad" : "wait";
  // Build the pill label text to match, e.g. "dashcam_1 • live". Template strings use backticks and ${…} placeholders.
  const statusLabel =
    connected === true
      ? `${sourceName} • live`
      : connected === false
        ? `${sourceName} • disconnected`
        : `${sourceName} • connecting…`;

  return (
    /* <header> = the full-width bar stuck to the top of the viewport. */
    <header className={styles.topbar}>
      {/* Brand/logo on the far left — clock icon + "Road Safety" text, acts as a link back to "/". */}
      <Link to="/" className={styles.brand}>
        {/* Inline SVG: a circle with a clock hand (Road Safety logo mark). */}
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
      {/* Middle nav group — three links. The active one gets the `.active` class for a highlighted style. */}
      <nav className={styles.nav}>
        {/* Admin link — highlighted when URL is exactly "/". */}
        <Link to="/" className={pathname === "/" ? styles.active : ""}>
          Admin
        </Link>
        {/* Dashboard link — highlighted on "/dashboard". */}
        <Link to="/dashboard" className={pathname === "/dashboard" ? styles.active : ""}>
          Dashboard
        </Link>
        {/* Monitoring link — template-string className combines the always-on `.monLink` class with the active-state class.
            Also hosts the red error bubble (count of watchdog errors). */}
        <Link
          to="/monitoring"
          className={`${styles.monLink} ${pathname === "/monitoring" ? styles.active : ""}`}
        >
          Monitoring
          {/* Conditional render: only show the small red bubble when there is at least one watchdog error.
              `cond && <X/>` means "render <X/> if cond is truthy, otherwise nothing". */}
          {errorCount > 0 && (
            <span className={styles.errorBubble}>{errorCount}</span>
          )}
        </Link>
      </nav>
      {/* Flexible spacer — empty <span> that pushes the pill + children to the right side of the bar. */}
      <span className={styles.spacer} />
      {/* Live-status pill on the right: the colored <Dot/> plus the source/state label, e.g. "dashcam_1 • live". */}
      <Pill>
        <Dot variant={statusVariant} />
        <span>{statusLabel}</span>
      </Pill>
      {/* Slot for extras injected by each page — e.g. the uptime pill on Admin, or TestBadge + WatchdogBadge on Dashboard. */}
      {children}
    </header>
  );
}
