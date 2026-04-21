/**
 * WatchdogBadge — small "Monitoring" pill rendered in the TopBar. Surfaces
 * the worst-current severity with a coloured dot and the error count.
 *
 * --- UI mapping ---
 * Page: Global (TopBar of every page).
 * UI element: the watchdog badge in the top bar showing a coloured dot
 *   and the incident count; clicking it opens the WatchdogDrawer.
 */
import type { WatchdogStatus } from "../../../shared/types/common";

import styles from "./WatchdogBadge.module.css";

/** Props for {@link WatchdogBadge}. */
interface WatchdogBadgeProps {
  status: WatchdogStatus | null;
  onClick: () => void;
}

/**
 * Render the TopBar monitoring pill. Returns `null` to render nothing
 * when the watchdog is disabled or status hasn't loaded — `null` is
 * React's official "render nothing" value.
 */
export function WatchdogBadge({ status, onClick }: WatchdogBadgeProps) {
  if (!status || !status.enabled) return null;

  const errors = status.by_severity?.error ?? 0;
  const warnings = status.by_severity?.warning ?? 0;
  const total = status.total_findings;

  // Pick the single dot colour matching the most severe category present.
  const severity = errors > 0 ? "error" : warnings > 0 ? "warning" : total > 0 ? "info" : "ok";

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
      {errors > 0 && <span className={styles.errorBubble}>{errors}</span>}
    </div>
  );
}
