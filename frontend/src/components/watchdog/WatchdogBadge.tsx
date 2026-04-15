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
      <span className={`${styles.dot} ${styles[severity]}`} />
      <span>Monitoring</span>
      {total > 0 && (
        <span className={styles.counts}>
          {errors > 0 && <span className={styles.cntErr}>{errors}</span>}
          {warnings > 0 && <span className={styles.cntWarn}>{warnings}</span>}
          {errors === 0 && warnings === 0 && (
            <span className={styles.cntInfo}>{total}</span>
          )}
        </span>
      )}
    </div>
  );
}
