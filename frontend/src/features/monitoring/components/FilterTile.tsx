/**
 * FilterTile — single clickable severity counter inside the summary grid.
 *
 * Intentionally dumb: no state, no logic. Takes a label+value+variant
 * and reports clicks. The parent (`SummaryGrid`) owns the filter state.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: a single big clickable counter tile inside the row of four
 *   filter tiles near the top of the page (one of Errors / Warnings /
 *   Info / Incidents).
 */
import styles from "../MonitoringPage.module.css";

/**
 * Props shape. `number | string` is a union — either type is allowed,
 * so counts (numbers) and the "Incidents" total (often shown as-is)
 * can both be passed. `() => void` marks a callback that takes no args
 * and returns nothing.
 */
interface FilterTileProps {
  label: string;
  value: number | string;
  variant: string;
  active: boolean;
  onClick: () => void;
}

/**
 * Render the tile as a button. Reports clicks up to the parent; the
 * parent decides whether this becomes an active filter.
 */
export function FilterTile({ label, value, variant, active, onClick }: FilterTileProps) {
  return (
    <button
      type="button"
      // Template literal (`${…}`) composes classes. `styles[`t${variant}`]`
      // is a dynamic lookup — e.g. variant "error" reads styles.terror.
      className={`${styles.tile} ${styles[`t${variant}`]} ${active ? styles.tileActive : ""}`}
      onClick={onClick}
    >
      <div className={styles.tLabel}>{label}</div>
      <div className={styles.tValue}>{value}</div>
    </button>
  );
}
