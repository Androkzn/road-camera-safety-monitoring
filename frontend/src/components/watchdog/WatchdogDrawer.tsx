/**
 * WatchdogDrawer.tsx — slide-out panel listing watchdog findings.
 *
 * What it does:
 *   Opens as a right-side drawer with four summary tiles (Errors, Warnings,
 *   Info, All) that double as severity filters, a meta line ("Checks: N |
 *   Interval: 60s | Last check: 12s ago"), and a scrollable list of
 *   findings grouped by category. Also supports a multi-select mode for
 *   bulk delete, plus a "Clear All" action.
 *
 * Purpose:
 *   Lets the operator inspect and dismiss pipeline self-diagnostic issues
 *   (e.g., low FPS, model confidence drops) produced by the backend
 *   watchdog.
 *
 * How it works:
 *   - Props: `open`/`onClose` control visibility, `status` and `findings`
 *     are the fetched data (each nullable), `onDeleteSelected(keys)` and
 *     `onClearAll()` are async handlers provided by the parent.
 *   - `useState` holds local UI state: current severity filter, whether
 *     we're in multi-select mode, the `Set<string>` of selected row keys,
 *     and a `deleting` spinner flag.
 *   - `useCallback` wraps handlers so their identity stays stable across
 *     renders — useful when passing them to children or `useEffect` deps.
 *   - Findings are sorted by severity then timestamp, filtered by the
 *     chosen severity, and grouped into a `byCategory` dictionary. Each
 *     group renders via `.map()` (loops the list and renders one item
 *     each) with a `findingKey(f)` stable key for React.
 *   - `<FilterTile>` is a small inner component used four times.
 *
 * Connects to:
 *   - Backend: data and actions come from the parent (usually via
 *     `useWatchdog` or `WatchdogContext`) hitting `/api/watchdog`,
 *     `/api/watchdog/recent`, `/api/watchdog/findings/delete`, and
 *     `/api/watchdog/findings?clear_all=true`.
 *   - UI: historically rendered from an AdminPage-style caller that passes
 *     the watchdog hook data in. `pages/MonitoringPage.tsx` implements its
 *     own richer layout rather than using this drawer directly.
 */
// `useState` = React hook that stores a value between renders.
// `useCallback` = memoizes a function so its identity stays stable across renders (useful for passing to children).
import { useState, useCallback } from "react";
import type { WatchdogFinding, WatchdogStatus } from "../../types";
import styles from "./WatchdogDrawer.module.css";

// Severity icon glyph shown on each finding row.
const SEV_ICON: Record<string, string> = {
  error: "!!",
  warning: "!",
  info: "i",
};

// Ordering key: errors first, then warnings, then info — used by .sort() below.
const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

// Allowed filter values for the top tiles. Union of literal strings.
type SevFilter = "all" | "error" | "warning" | "info";

// findingKey — builds a stable unique string for a finding (`snapshot_id_ts`).
// Used as the map key for selection state and for React list keys.
function findingKey(f: WatchdogFinding): string {
  return `${f.snapshot_id}_${f.ts}`;
}

// Props: `open` toggles the slide-in, `onClose` closes it, `status`+`findings` are the fetched data,
// `onDeleteSelected` deletes a list of keys, `onClearAll` wipes everything (both optional async).
interface WatchdogDrawerProps {
  open: boolean;
  onClose: () => void;
  status: WatchdogStatus | null;
  findings: WatchdogFinding[] | null;
  onDeleteSelected?: (keys: string[]) => Promise<void>;
  onClearAll?: () => Promise<void>;
}

// WatchdogDrawer — slide-out panel from the right edge listing pipeline self-diagnostics.
// Contains four severity filter tiles, a selection bar, category-grouped findings, and bulk/clear actions.
export function WatchdogDrawer({
  open,
  onClose,
  status,
  findings,
  onDeleteSelected,
  onClearAll,
}: WatchdogDrawerProps) {
  // `useState` stores a value across renders. Destructure = [current value, setter].
  // Which severity tile is active (acts as filter).
  const [filter, setFilter] = useState<SevFilter>("all");
  // Are we in bulk-select mode? Toggled by the "Select" button in the header.
  const [selectMode, setSelectMode] = useState(false);
  // Set of selected finding keys — `Set` gives fast has/add/delete.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // True while a delete / clear request is in flight — disables buttons and shows "Deleting…".
  const [deleting, setDeleting] = useState(false);

  // Counts for the four summary tiles — all use `?.` + `??` to default missing values to 0.
  const errors = status?.by_severity?.error ?? 0;
  const warnings = status?.by_severity?.warning ?? 0;
  const infos = status?.by_severity?.info ?? 0;
  const total = status?.total_findings ?? 0;
  const lastAgo = status?.last_run_ago_sec;

  // Toggles a severity filter: clicking the active tile resets back to "all".
  const toggle = (sev: SevFilter) => {
    setFilter((prev) => (prev === sev ? "all" : sev));
  };

  // Copy (spread) then sort: errors first (SEV_ORDER), newest timestamp first within a severity.
  const allFindings = [...(findings ?? [])].sort((a, b) => {
    const sevDiff = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    return b.ts.localeCompare(a.ts);
  });

  // Apply the active severity filter. "all" keeps everything.
  const filtered =
    filter === "all"
      ? allFindings
      : allFindings.filter((f) => f.severity === filter);

  // Group filtered findings into a { category: [findings…] } dictionary for the list sections.
  const byCategory: Record<string, WatchdogFinding[]> = {};
  for (const f of filtered) {
    const cat = f.category || "system";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(f);
  }

  // `useCallback(fn, deps)` — keeps the same function reference between renders unless deps change.
  // Leaves multi-select mode and clears the current selection. Empty deps = stable forever.
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  // Toggles a single row's selection. Functional setState (`prev => next`) avoids stale state.
  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Marks every currently-filtered row as selected. Re-created when `filtered` changes.
  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map(findingKey)));
  }, [filtered]);

  // Calls the parent's bulk-delete with the selected keys, then exits select mode.
  // `async` + `await` wait for the Promise to resolve before continuing.
  const handleDeleteSelected = useCallback(async () => {
    if (!onDeleteSelected || selected.size === 0) return;
    setDeleting(true);
    try {
      await onDeleteSelected(Array.from(selected));
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [onDeleteSelected, selected, exitSelectMode]);

  // Calls the parent's "clear all" handler to wipe every finding.
  const handleClearAll = useCallback(async () => {
    if (!onClearAll) return;
    setDeleting(true);
    try {
      await onClearAll();
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [onClearAll, exitSelectMode]);

  return (
    /* Fragment wraps the dim overlay and the drawer panel as siblings (no extra DOM node). */
    <>
      {/* Dim backdrop behind the drawer. Clicking it closes. `.open` triggers its fade-in. */}
      <div
        className={`${styles.overlay} ${open ? styles.open : ""}`}
        onClick={onClose}
      />
      {/* The drawer panel — slides in from the right edge when `.open` is present. */}
      <aside className={`${styles.drawer} ${open ? styles.open : ""}`}>
        {/* Header row — title on the left, action buttons on the right (Select, Clear All, X). */}
        <div className={styles.head}>
          <h2>Error Monitoring</h2>
          <div className={styles.headActions}>
            {/* "Select" button — only shown outside of select mode and only when list isn't empty.
                Clicking enters bulk-select mode so checkboxes appear on each row. */}
            {!selectMode && filtered.length > 0 && (
              <button
                className={styles.actionBtn}
                onClick={() => setSelectMode(true)}
                title="Select findings"
              >
                Select
              </button>
            )}
            {/* "Clear All" destructive button — only when findings exist and parent provided a handler. */}
            {!selectMode && total > 0 && onClearAll && (
              <button
                className={`${styles.actionBtn} ${styles.clearBtn}`}
                onClick={handleClearAll}
                disabled={deleting}
                title="Clear all findings"
              >
                {deleting ? "Clearing…" : "Clear All"}
              </button>
            )}
            {/* X close button in the corner of the drawer header. */}
            <button className={styles.closeBtn} onClick={onClose} title="Close">
              &times;
            </button>
          </div>
        </div>

        {/* Selection action bar — appears only when in bulk-select mode.
            Left: "N selected", "Select all", "Deselect all". Right: "Delete (N)", "Cancel". */}
        {selectMode && (
          <div className={styles.selectionBar}>
            <div className={styles.selectionInfo}>
              <span>{selected.size} selected</span>
              {/* Selects every row currently visible after the severity filter. */}
              <button className={styles.selBarBtn} onClick={selectAll}>
                Select all ({filtered.length})
              </button>
              {/* Clears the selection but keeps bulk-select mode active. */}
              <button className={styles.selBarBtn} onClick={() => setSelected(new Set())}>
                Deselect all
              </button>
            </div>
            <div className={styles.selectionActions}>
              {/* Bulk delete — fires handleDeleteSelected. Disabled when nothing is selected. */}
              <button
                className={`${styles.selBarBtn} ${styles.deleteBtn}`}
                onClick={handleDeleteSelected}
                disabled={selected.size === 0 || deleting}
              >
                {deleting ? "Deleting…" : `Delete (${selected.size})`}
              </button>
              {/* Cancel exits bulk-select mode without deleting. */}
              <button className={styles.selBarBtn} onClick={exitSelectMode}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Four severity filter tiles. Clicking a tile filters the list (re-clicking active one returns to "all"). */}
        <div className={styles.summaryGrid}>
          <FilterTile label="Errors" value={errors} variant="error" active={filter === "error"} onClick={() => toggle("error")} />
          <FilterTile label="Warnings" value={warnings} variant="warning" active={filter === "warning"} onClick={() => toggle("warning")} />
          <FilterTile label="Info" value={infos} variant="info" active={filter === "info"} onClick={() => toggle("info")} />
          <FilterTile label="All" value={total} variant="total" active={filter === "all"} onClick={() => setFilter("all")} />
        </div>

        {/* Meta line under the tiles — total checks run, interval setting, and seconds since last check. */}
        <div className={styles.meta}>
          <span>
            Checks: {status?.run_count ?? 0} |
            Interval: {status?.interval_sec ?? 60}s
          </span>
          <span>
            {lastAgo != null ? `Last check: ${Math.round(lastAgo)}s ago` : "Waiting…"}
          </span>
        </div>

        {/* Small subtitle saying e.g. "Showing 3 errors" — reflects the active severity filter. */}
        <div className={styles.filterLabel}>
          {filter === "all"
            ? `Showing all ${filtered.length} findings`
            : `Showing ${filtered.length} ${filter}${filtered.length !== 1 ? "s" : ""}`}
        </div>

        {/* Scrollable list of findings, grouped by category. */}
        <div className={styles.findingsList}>
          {/* Empty state — wording depends on whether the backend has run a check yet. */}
          {filtered.length === 0 && (
            <div className={styles.emptyList}>
              {filter !== "all"
                ? `No ${filter} findings`
                : status?.run_count
                  ? "No issues found — system healthy"
                  : "Waiting for first check…"}
            </div>
          )}
          {/* One section per category. `.map` loops the grouped dictionary. `key={cat}` helps React reuse DOM. */}
          {Object.entries(byCategory).map(([cat, items]) => (
            <div className={styles.catGroup} key={cat}>
              {/* Category heading, e.g. "fps", "model", "system". */}
              <div className={styles.catHeader}>{cat}</div>
              {/* Inner `.map`: one card per finding inside this category. */}
              {items.map((f, i) => {
                const key = findingKey(f);
                const isSelected = selected.has(key);
                return (
                  /* One finding card — colored by severity; gains `.selectable`/`.selected` classes in bulk mode.
                     Row-click in select mode toggles selection; normal mode has no row click. */
                  <div
                    className={`${styles.findingItem} ${styles[f.severity]} ${selectMode ? styles.selectable : ""} ${isSelected ? styles.selected : ""}`}
                    key={`${f.snapshot_id}-${i}`}
                    onClick={selectMode ? () => toggleSelect(key) : undefined}
                  >
                    {/* Top row inside the card: checkbox (select mode) + severity icon + title + timestamp + per-row delete "×". */}
                    <div className={styles.findingTop}>
                      {/* Checkbox column — only visible during bulk-select. Shows a ✓ when selected. */}
                      {selectMode && (
                        <span className={`${styles.checkbox} ${isSelected ? styles.checked : ""}`}>
                          {isSelected ? "✓" : ""}
                        </span>
                      )}
                      {/* Severity glyph (!!, !, i) colored by severity class. */}
                      <span className={`${styles.sevIcon} ${styles[f.severity]}`}>
                        {SEV_ICON[f.severity] ?? "?"}
                      </span>
                      {/* Finding title and local-time stamp. */}
                      <span className={styles.findingTitle}>{f.title}</span>
                      <span className={styles.findingTs}>
                        {new Date(f.ts).toLocaleTimeString()}
                      </span>
                      {/* Per-finding delete "×" — only outside select mode.
                          `e.stopPropagation()` stops the row's onClick from also firing. */}
                      {!selectMode && onDeleteSelected && (
                        <button
                          className={styles.deleteSingle}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSelected([key]);
                          }}
                          title="Delete this finding"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                    {/* The longer human-readable finding description. */}
                    <div className={styles.findingDetail}>{f.detail}</div>
                    {/* Optional remediation hint — only shown when the backend attached one. */}
                    {f.suggestion && (
                      <div className={styles.findingSuggestion}>{f.suggestion}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

// FilterTile — one of the four clickable tiles at the top (Errors/Warnings/Info/All).
// `active` applies a highlight class showing which severity filter is current.
function FilterTile({
  label,
  value,
  variant,
  active,
  onClick,
}: {
  label: string;
  value: number | string;
  variant: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    /* Clickable tile — composes base `.tile` + variant color + active highlight. */
    <div
      className={`${styles.tile} ${styles[`t${variant}`]} ${active ? styles.tileActive : ""}`}
      onClick={onClick}
    >
      <div className={styles.tLabel}>{label}</div>
      {/* Zero is falsy, so `value || "—"` renders a dash instead of "0". */}
      <div className={styles.tValue}>{value || "—"}</div>
    </div>
  );
}
