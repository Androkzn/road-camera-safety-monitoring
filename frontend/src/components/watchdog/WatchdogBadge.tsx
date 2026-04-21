/**
 * WatchdogBadge.tsx — small clickable chip that summarizes watchdog health.
 *
 * What it does:
 *   Shows a colored dot plus the label "Monitoring", and a red number
 *   bubble with the error count when errors exist. Severity color picks
 *   automatically: red if any errors, amber if any warnings, blue if info
 *   only, green if clean. Clicking calls `onClick` (opens a drawer).
 *
 * Purpose:
 *   Persistent top-bar surface so operators notice pipeline self-checks
 *   without staring at the Monitoring page.
 *
 * How it works:
 *   - Props: `status` (WatchdogStatus or null) and `onClick` handler.
 *   - `if (!status || !status.enabled) return null;` — "early return null"
 *     is React's idiom for "render nothing". If watchdog is disabled on
 *     the backend, nothing appears.
 *   - The severity variable is computed via nested ternaries based on
 *     error/warning/total counts.
 *   - Conditional rendering (`errors > 0 && <span>…)` shows the red bubble
 *     only when it's non-zero.
 *
 * Connects to:
 *   - Backend: status is fetched by the parent (typically via
 *     `useWatchdog` / `WatchdogContext`) from `GET /api/watchdog`.
 *   - UI: intended to live in the `<TopBar>` children slot on pages that
 *     want a persistent watchdog indicator. On the current Monitoring
 *     page, the top-bar error bubble is rendered by `TopBar` itself rather
 *     than this badge.
 */
import type { WatchdogStatus } from "../../types";
import styles from "./WatchdogBadge.module.css";

interface WatchdogBadgeProps {
  status: WatchdogStatus | null;
  onClick: () => void;
}

export function WatchdogBadge({ status, onClick }: WatchdogBadgeProps) {
  if (!status || !status.enabled) return null;

  const errors = status.by_severity?.error ?? 0;
  const warnings = status.by_severity?.warning ?? 0;
  const total = status.total_findings;

  const severity =
    errors > 0 ? "error" : warnings > 0 ? "warning" : total > 0 ? "info" : "ok";

  return (
    <div
      className={styles.badge}
      title="Error Monitoring — click to view findings"
      onClick={onClick}
      style={{ marginLeft: 8 }}
    >
      <span className={styles.label}>
        <span className={`${styles.dot} ${styles[severity]}`} />
        <span>Monitoring</span>
      </span>
      {errors > 0 && (
        <span className={styles.errorBubble}>{errors}</span>
      )}
    </div>
  );
}
