/**
 * WatchdogDrawer — side panel that lists current watchdog findings
 * (system-health "incidents" grouped by severity + category).
 *
 * Design goal (from CLAUDE.md):
 *   An INCIDENT QUEUE, not a log-tail wall of red. Findings are grouped and
 *   fingerprinted upstream in road_safety/services/watchdog.py; this UI
 *   should stay triage-oriented: filter by severity, select + delete resolved
 *   ones, clear all.
 *
 * Parent:
 *   Opened by clicking <WatchdogBadge /> in the TopBar (see
 *   ./WatchdogBadge.tsx). The parent page owns the `open` boolean and the
 *   `onClose` callback. `status` / `findings` / delete callbacks come from
 *   `useWatchdogCtx()` (../../hooks/WatchdogContext.tsx).
 *
 * React concepts first taught here:
 *   - Multiple `useState` hooks (filter, selectMode, Set selection, deleting flag).
 *   - `useState<Set<string>>(new Set())` — Set as React state; see notes below
 *     about immutability when updating.
 *   - Functional-updater form: `setSelected(prev => ...)`.
 *   - `useCallback` for stable handlers and memoized delete flows.
 *   - List rendering with `.map(...)` and the all-important `key` prop.
 *   - Nested list rendering (categories → findings).
 *   - Sorting + filtering derived from state on each render.
 *   - Event-bubbling control via `event.stopPropagation()` on a child click.
 *   - Fragment wrapper `<> ... </>` to return siblings from a component.
 *   - Sub-component defined in the same file (`FilterTile`) and the
 *     inline-props-type pattern (no separate interface).
 *   - ARIA/keyboard notes on drawer open/close semantics.
 */

import { useState, useCallback } from "react";
import type { WatchdogFinding, WatchdogStatus } from "../../types";
import styles from "./WatchdogDrawer.module.css";

// --- Module-scope constants ---

// TEACH: `Record<K, V>` is TypeScript shorthand for an object type whose keys
// are `K` and values are `V`. Here: severity string → glyph.
const SEV_ICON: Record<string, string> = {
  error: "!!",
  warning: "!",
  info: "i",
};

// Sort priority — lower number sorts first.
const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

// TEACH: `type X = "a" | "b"` is a string-literal union — a set of allowed
// string values. TypeScript will reject `setFilter("nope")` at compile time.
type SevFilter = "all" | "error" | "warning" | "info";

// Stable per-finding identity used as a Set key and for React list keys.
// `snapshot_id + ts` is unique enough; the backend does not ship a true PK.
function findingKey(f: WatchdogFinding): string {
  return `${f.snapshot_id}_${f.ts}`;
}

// --- Types ---

interface WatchdogDrawerProps {
  open: boolean;
  onClose: () => void;
  status: WatchdogStatus | null;
  findings: WatchdogFinding[] | null;
  // TEACH: `?` on methods makes the whole callback optional. A parent that
  // doesn't care about deletion can simply omit these.
  onDeleteSelected?: (keys: string[]) => Promise<void>;
  onClearAll?: () => Promise<void>;
}

// --- Component ---

export function WatchdogDrawer({
  open,
  onClose,
  status,
  findings,
  onDeleteSelected,
  onClearAll,
}: WatchdogDrawerProps) {
  // --- State ---

  // Current severity filter. `toggle(sev)` turns this chip on/off; "all"
  // disables filtering.
  const [filter, setFilter] = useState<SevFilter>("all");

  // `selectMode` flips the drawer into bulk-edit mode (checkboxes appear).
  const [selectMode, setSelectMode] = useState(false);

  // TEACH: Set stored in state. IMPORTANT: React detects changes by
  // reference equality, so you MUST create a NEW Set when updating —
  // mutating the existing Set and calling setSelected(sameRef) will NOT
  // trigger a re-render. See `toggleSelect` below for the correct pattern.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Disabled-while-working flag for the delete buttons.
  const [deleting, setDeleting] = useState(false);

  // --- Derived values ---

  // Snapshot counts from the status object; `??` gives 0 when missing.
  const errors = status?.by_severity?.error ?? 0;
  const warnings = status?.by_severity?.warning ?? 0;
  const infos = status?.by_severity?.info ?? 0;
  const total = status?.total_findings ?? 0;
  const lastAgo = status?.last_run_ago_sec;

  // --- Handlers (simple inline) ---

  // TEACH: Inline arrow handler (no useCallback). Fine here because it only
  // calls `setFilter`, which React guarantees is a stable reference, and
  // this handler isn't passed to a memoized child.
  const toggle = (sev: SevFilter) => {
    // TEACH: Functional-updater form: `setFilter(prev => next)`. Use this
    // whenever the new state depends on the previous one; React may batch
    // updates and the "current" closure variable can be stale.
    setFilter((prev) => (prev === sev ? "all" : sev));
  };

  // Sort & filter findings on every render. Re-running these cheaply is
  // usually fine; `useMemo` only pays off when the work is expensive or the
  // reference identity matters for a memoized child.
  // TEACH: `[...arr].sort(...)` copies the array first — Array.prototype.sort
  // mutates in place, and we should never mutate props.
  const allFindings = [...(findings ?? [])].sort((a, b) => {
    const sevDiff = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    return b.ts.localeCompare(a.ts);
  });

  const filtered =
    filter === "all"
      ? allFindings
      : allFindings.filter((f) => f.severity === filter);

  // Bucket filtered findings by category for grouped display.
  const byCategory: Record<string, WatchdogFinding[]> = {};
  for (const f of filtered) {
    const cat = f.category || "system";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(f);
  }

  // --- Handlers (memoized) ---

  // TEACH: `useCallback` with `[]` deps means the returned function identity
  // never changes for this component's lifetime. Good for handlers that
  // don't close over any changing values.
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  // Toggle a single finding's selection. This is the canonical "update a Set
  // in state" pattern — build a NEW Set from the previous one, mutate the
  // copy, return it.
  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Select every currently-visible (filtered) finding.
  // TEACH: `[filtered]` in deps means this handler's reference changes when
  // the filtered list changes. That's fine; consumers read it inline.
  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map(findingKey)));
  }, [filtered]);

  // Delete handler — async, flips `deleting` to true while the POST runs.
  const handleDeleteSelected = useCallback(async () => {
    if (!onDeleteSelected || selected.size === 0) return;
    setDeleting(true);
    try {
      // TEACH: `Array.from(set)` converts a Set to an Array — the API wants
      // a plain JSON-serializable list.
      await onDeleteSelected(Array.from(selected));
      exitSelectMode();
    } finally {
      // `finally` ensures the busy flag always resets, even on errors.
      setDeleting(false);
    }
  }, [onDeleteSelected, selected, exitSelectMode]);

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

  // --- Render ---

  return (
    // TEACH: `<> ... </>` is a React Fragment — a wrapper that renders its
    // children without adding an extra DOM node. Lets us return two sibling
    // elements (overlay + drawer) without wrapping them in a throwaway div.
    <>
      {/* Click-to-dismiss overlay.
          TEACH (keyboard/ARIA): A production-grade drawer would also close on
          the Escape key and trap focus inside the drawer while open. If you
          add that, use a `useEffect` that attaches a `keydown` listener on
          mount and removes it in the cleanup function. */}
      <div
        className={`${styles.overlay} ${open ? styles.open : ""}`}
        onClick={onClose}
      />
      <aside className={`${styles.drawer} ${open ? styles.open : ""}`}>
        {/* Drawer header: title + action buttons + close. */}
        <div className={styles.head}>
          <h2>Error Monitoring</h2>
          <div className={styles.headActions}>
            {/* Enter select-mode button. */}
            {!selectMode && filtered.length > 0 && (
              <button
                className={styles.actionBtn}
                onClick={() => setSelectMode(true)}
                title="Select findings"
              >
                Select
              </button>
            )}
            {/* Clear all — only when the parent supplied the callback. */}
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
            <button className={styles.closeBtn} onClick={onClose} title="Close">
              &times;
            </button>
          </div>
        </div>

        {/* Bulk-selection toolbar, only visible in select mode. */}
        {selectMode && (
          <div className={styles.selectionBar}>
            <div className={styles.selectionInfo}>
              <span>{selected.size} selected</span>
              <button className={styles.selBarBtn} onClick={selectAll}>
                Select all ({filtered.length})
              </button>
              <button className={styles.selBarBtn} onClick={() => setSelected(new Set())}>
                Deselect all
              </button>
            </div>
            <div className={styles.selectionActions}>
              <button
                className={`${styles.selBarBtn} ${styles.deleteBtn}`}
                onClick={handleDeleteSelected}
                disabled={selected.size === 0 || deleting}
              >
                {deleting ? "Deleting…" : `Delete (${selected.size})`}
              </button>
              <button className={styles.selBarBtn} onClick={exitSelectMode}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Severity filter tiles — clickable counters at the top of the list. */}
        <div className={styles.summaryGrid}>
          <FilterTile label="Errors" value={errors} variant="error" active={filter === "error"} onClick={() => toggle("error")} />
          <FilterTile label="Warnings" value={warnings} variant="warning" active={filter === "warning"} onClick={() => toggle("warning")} />
          <FilterTile label="Info" value={infos} variant="info" active={filter === "info"} onClick={() => toggle("info")} />
          <FilterTile label="All" value={total} variant="total" active={filter === "all"} onClick={() => setFilter("all")} />
        </div>

        {/* Scan metadata row. */}
        <div className={styles.meta}>
          <span>
            Checks: {status?.run_count ?? 0} |
            Interval: {status?.interval_sec ?? 60}s
          </span>
          <span>
            {lastAgo != null ? `Last check: ${Math.round(lastAgo)}s ago` : "Waiting…"}
          </span>
        </div>

        <div className={styles.filterLabel}>
          {filter === "all"
            ? `Showing all ${filtered.length} findings`
            : `Showing ${filtered.length} ${filter}${filtered.length !== 1 ? "s" : ""}`}
        </div>

        {/* --- Findings list --- */}
        <div className={styles.findingsList}>
          {/* Empty-state messaging. */}
          {filtered.length === 0 && (
            <div className={styles.emptyList}>
              {filter !== "all"
                ? `No ${filter} findings`
                : status?.run_count
                  ? "No issues found — system healthy"
                  : "Waiting for first check…"}
            </div>
          )}
          {/* TEACH: `Object.entries(obj)` yields `[key, value]` pairs. We then
              `.map(...)` over them to render one category group per bucket. */}
          {Object.entries(byCategory).map(([cat, items]) => (
            // TEACH: `key` is a special React prop on lists. It should be a
            // STABLE, UNIQUE id per sibling — React uses it to diff the list
            // efficiently across renders. Never use the array index unless
            // the list order truly never changes.
            <div className={styles.catGroup} key={cat}>
              <div className={styles.catHeader}>{cat}</div>
              {items.map((f, i) => {
                const key = findingKey(f);
                const isSelected = selected.has(key);
                return (
                  <div
                    className={`${styles.findingItem} ${styles[f.severity]} ${selectMode ? styles.selectable : ""} ${isSelected ? styles.selected : ""}`}
                    // TEACH: Combining the snapshot_id with an index keeps
                    // keys unique even if two findings share a snapshot_id.
                    // snapshot_id alone would collide in that edge case.
                    key={`${f.snapshot_id}-${i}`}
                    // TEACH: Ternary in a prop — when we're in selectMode,
                    // clicking the item toggles its selection; otherwise we
                    // leave `onClick` undefined so the row does nothing.
                    onClick={selectMode ? () => toggleSelect(key) : undefined}
                  >
                    <div className={styles.findingTop}>
                      {selectMode && (
                        <span className={`${styles.checkbox} ${isSelected ? styles.checked : ""}`}>
                          {isSelected ? "✓" : ""}
                        </span>
                      )}
                      <span className={`${styles.sevIcon} ${styles[f.severity]}`}>
                        {SEV_ICON[f.severity] ?? "?"}
                      </span>
                      <span className={styles.findingTitle}>{f.title}</span>
                      <span className={styles.findingTs}>
                        {new Date(f.ts).toLocaleTimeString()}
                      </span>
                      {/* Per-row delete "×" — only when NOT in select mode. */}
                      {!selectMode && onDeleteSelected && (
                        <button
                          className={styles.deleteSingle}
                          onClick={(e) => {
                            // TEACH: `e.stopPropagation()` prevents the click
                            // from bubbling up to the parent row's onClick.
                            // Without this, clicking "×" while in select mode
                            // would also toggle selection — surprising UX.
                            e.stopPropagation();
                            onDeleteSelected([key]);
                          }}
                          title="Delete this finding"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                    <div className={styles.findingDetail}>{f.detail}</div>
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

// --- Sub-component ---

/**
 * FilterTile — a single clickable counter in the severity grid.
 *
 * TEACH: You can define multiple components in one file. Keep them here when
 * they're only used by this file; promote to their own file once they're
 * reused elsewhere.
 *
 * TEACH: The props type is declared INLINE (`: { ... }`) instead of as a
 * separate `interface`. Inline is fine for small local components; for
 * anything exported or reused, prefer a named interface for readability.
 */
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
    <div
      // TEACH: `styles[\`t${variant}\`]` dynamically builds a CSS-Modules
      // class name — so `variant="error"` picks up `styles.terror`. This
      // only works because the author named the classes consistently.
      className={`${styles.tile} ${styles[`t${variant}`]} ${active ? styles.tileActive : ""}`}
      onClick={onClick}
    >
      <div className={styles.tLabel}>{label}</div>
      <div className={styles.tValue}>{value || "—"}</div>
    </div>
  );
}
