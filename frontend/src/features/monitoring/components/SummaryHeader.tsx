/**
 * SummaryHeader — title + Select / Clear All actions on the Monitoring page.
 *
 * Renders the page heading and the primary action buttons, and accepts
 * arbitrary children (MonitoringPage slots in a "Show low severity"
 * checkbox here).
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: the page heading "Error Monitoring" with its subtitle, plus
 *   the Select / Clear All buttons and the "Show low severity" checkbox
 *   slotted in on the right.
 */
// `ReactNode` is the built-in type for "anything valid inside JSX" —
// elements, strings, numbers, arrays, null, fragments. Used for children.
import type { ReactNode } from "react";

import styles from "../MonitoringPage.module.css";

/**
 * Props. `children?: ReactNode` makes `children` optional and typed;
 * this is how React's JSX nesting shows up inside the function.
 */
interface SummaryHeaderProps {
  selectMode: boolean;
  totalIncidents: number;
  filteredCount: number;
  deleting: boolean;
  onEnterSelect: () => void;
  onClearAll: () => void;
  children?: ReactNode;
}

/**
 * Render the header. Hides the Select / Clear-All buttons when the queue
 * is empty or already in select mode, and disables Clear-All while a
 * delete request is in flight to prevent double-submits.
 */
export function SummaryHeader({
  selectMode,
  totalIncidents,
  filteredCount,
  deleting,
  onEnterSelect,
  onClearAll,
  children,
}: SummaryHeaderProps) {
  return (
    <div className={styles.titleRow}>
      <div>
        <h1>Error Monitoring</h1>
        <p className={styles.subtitle}>
          Grouped into actionable incidents with impact, evidence, and next debugging moves.
        </p>
      </div>
      <div className={styles.headerActions}>
        {!selectMode && filteredCount > 0 && (
          <button type="button" className={styles.actionBtn} onClick={onEnterSelect}>
            Select
          </button>
        )}
        {!selectMode && totalIncidents > 0 && (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.clearBtn}`}
            onClick={onClearAll}
            disabled={deleting}
          >
            {deleting ? "Clearing…" : "Clear All"}
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
