/**
 * MetaGrid — three meta cards under the summary grid (Watchdog / Active
 * Queue / Cadence).
 *
 * Purely informational: how often the watchdog runs, how many incidents
 * are currently visible, how many are repeating. Reinforces the
 * "fingerprinted queue, not a log tail" mental model in Cadence.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: the row of three small info cards just under the four
 *   filter tiles — "Watchdog" (run count + last check), "Active Queue"
 *   (visible / repeating counts), and "Cadence" (interval).
 */
import { THRESHOLDS } from "../../../shared/config/runtime";
import type { WatchdogStatus } from "../../../shared/types/common";

import styles from "../MonitoringPage.module.css";

/** Props — `status` is `| null` because it may not have loaded yet. */
interface MetaGridProps {
  status: WatchdogStatus | null;
  filteredCount: number;
  repeatingIncidents: number;
}

/**
 * Render three static info cards. No state, no callbacks — everything
 * derived from props, so re-renders are cheap.
 */
export function MetaGrid({ status, filteredCount, repeatingIncidents }: MetaGridProps) {
  // Optional chaining: yields undefined if `status` itself is null.
  const lastAgo = status?.last_run_ago_sec;
  return (
    <div className={styles.metaGrid}>
      <div className={styles.metaCard}>
        <span className={styles.metaLabel}>Watchdog</span>
        <strong>{status?.run_count ?? 0} runs</strong>
        <span>
          {lastAgo != null ? `Last check ${Math.round(lastAgo)}s ago` : "Waiting for first check"}
        </span>
      </div>
      <div className={styles.metaCard}>
        <span className={styles.metaLabel}>Active Queue</span>
        <strong>{filteredCount} visible incidents</strong>
        <span>{repeatingIncidents} repeating in the recent window</span>
      </div>
      <div className={styles.metaCard}>
        <span className={styles.metaLabel}>Cadence</span>
        <strong>{status?.interval_sec ?? THRESHOLDS.defaultWatchdogIntervalSec}s interval</strong>
        <span>Grouped by incident fingerprint, not raw line count</span>
      </div>
    </div>
  );
}
