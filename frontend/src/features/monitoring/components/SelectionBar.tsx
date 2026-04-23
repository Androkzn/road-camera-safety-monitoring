/**
 * SelectionBar — bulk-edit toolbar visible only in select mode.
 *
 * Shows how many items are selected, plus Select-all / Deselect-all /
 * Delete / Cancel buttons. Disabled state prevents empty or concurrent
 * deletes.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: the bulk-edit toolbar that appears between the meta cards
 *   and the incident feed when the user clicks "Select"; holds the
 *   selected-count, Select-all / Deselect-all, Delete and Cancel buttons.
 */
import styles from "../MonitoringPage.module.css";

/** Props — counts drive labels; four callbacks wire the buttons. */
interface SelectionBarProps {
  selectedCount: number;
  filteredCount: number;
  deleting: boolean;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDeleteSelected: () => void;
  onCancel: () => void;
}

/**
 * Render the toolbar. Delete button is disabled when nothing is
 * selected OR when a deletion is already in flight.
 */
export function SelectionBar({
  selectedCount,
  filteredCount,
  deleting,
  onSelectAll,
  onDeselectAll,
  onDeleteSelected,
  onCancel,
}: SelectionBarProps) {
  return (
    <div className={styles.selectionBar}>
      <div className={styles.selectionInfo}>
        <span>{selectedCount} incident groups selected</span>
        <button type="button" className={styles.selBarBtn} onClick={onSelectAll}>
          Select all ({filteredCount})
        </button>
        <button type="button" className={styles.selBarBtn} onClick={onDeselectAll}>
          Deselect all
        </button>
      </div>
      <div className={styles.selectionActions}>
        <button
          type="button"
          className={`${styles.selBarBtn} ${styles.deleteBtn}`}
          onClick={onDeleteSelected}
          disabled={selectedCount === 0 || deleting}
        >
          {deleting ? "Deleting…" : `Delete (${selectedCount})`}
        </button>
        <button type="button" className={styles.selBarBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
