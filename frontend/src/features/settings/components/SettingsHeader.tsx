/**
 * The header strip at the top of the Settings page.
 *
 * Shows the page title "Settings", a small "X pending changes" counter, and the
 * two main buttons: Discard (throws away unsaved edits) and Apply (saves them).
 * Both buttons stay disabled until the operator changes at least one slider.
 *
 * Page: SettingsPage
 *   ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: the title row at the very top of the page, with the Discard
 *   and Apply buttons on the right.
 *
 * Backend: no direct calls. Emits `onDiscard` / `onApply` callbacks; the
 *   parent page turns those into the POST /api/settings/apply request
 *   (and a local reset of the draft map on discard).
 */
import styles from "../SettingsPage.module.css";

interface SettingsHeaderProps {
  dirtyCount: number;
  submitting: boolean;
  onDiscard: () => void;
  onApply: () => void;
}

/**
 * Render the title + pending-changes counter + action buttons.
 *
 * Parent: SettingsPage (owns the draft map, mutation state, and handlers).
 * Children: none — just text and two <button>s.
 * BE: indirect via `onApply` → parent calls POST /api/settings/apply.
 *
 * `submitting` drives the button label ("Applying…") and disables Apply
 * to block double-submits while the mutation is in flight.
 */
export function SettingsHeader({
  dirtyCount,
  submitting,
  onDiscard,
  onApply,
}: SettingsHeaderProps) {
  return (
    <div className={styles.pageHeader}>
      <div className={styles.pageTitleGroup}>
        <h1 className={styles.pageTitle}>Settings</h1>
      </div>
      <div className={styles.headerActions}>
        <span className={styles.dirtyCount}>
          {dirtyCount} pending change{dirtyCount === 1 ? "" : "s"}
        </span>
        <button type="button" className={styles.btn} disabled={!dirtyCount} onClick={onDiscard}>
          Discard
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={!dirtyCount || submitting}
          onClick={onApply}
        >
          {submitting ? "Applying…" : `Apply${dirtyCount ? ` (${dirtyCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
