/**
 * SummaryTiles — KPI tiles row (Events / High / Medium / Uptime).
 *
 * Pure presentational component: all numbers come in via props. Lives
 * at the top of the DashboardPage, just under the page chrome.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: the four big number tiles at the top of the dashboard
 *   (Events / High risk / Medium risk / Uptime).
 */
import { formatUptime } from "../../../shared/lib/format";

import styles from "./SummaryTiles.module.css";

// TEACH: `uptimeSec?: number | null` — the `?` makes the prop
// optional; the `| null` lets callers explicitly signal "no data yet"
// vs "didn't bother to pass it". Minor distinction, useful in APIs.
interface SummaryTilesProps {
  total: number;
  high: number;
  medium: number;
  uptimeSec?: number | null;
}

/** Four-tile KPI strip rendered as a simple flex row. */
export function SummaryTiles({ total, high, medium, uptimeSec }: SummaryTilesProps) {
  return (
    <div className={styles.summary}>
      <div className={styles.tile}>
        <div className={styles.label}>Events</div>
        <div className={styles.value}>{total}</div>
      </div>
      <div className={`${styles.tile} ${styles.high}`}>
        <div className={styles.label}>High risk</div>
        <div className={styles.value}>{high}</div>
      </div>
      <div className={`${styles.tile} ${styles.medium}`}>
        <div className={styles.label}>Medium risk</div>
        <div className={styles.value}>{medium}</div>
      </div>
      <div className={styles.tile}>
        <div className={styles.label}>Uptime</div>
        <div className={styles.value}>{formatUptime(uptimeSec)}</div>
      </div>
    </div>
  );
}
