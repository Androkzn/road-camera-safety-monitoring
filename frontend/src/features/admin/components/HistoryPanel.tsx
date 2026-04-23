/**
 * HistoryPanel — a filterable list of past safety events fetched from
 * GET /api/events/history (not the live SSE feed at /api/events/stream).
 *
 * Where it renders:
 *   One of the tabs inside AdminPage.tsx (shared/ui/Tabs). Unlike
 *   DetectionsPanel (which is live), this panel
 *   queries the backend on mount and on filter change.
 *
 * Props:
 *   (none) — this component is self-contained: it owns its own data via
 *   the useHistory() hook. Most of our other admin panels are pure and
 *   prop-driven; this one is a good contrast for teaching "where should
 *   data live?" in React.
 *
 * Visual region:
 *   A filter bar at the top (risk level <select>, event type <select>,
 *   refresh <button>, count) followed by a scrollable list of
 *   <AdminEventCard> items. Handles loading / error / empty states
 *   inline.
 *
 * React concepts demonstrated in this file:
 *   - Consuming a *custom hook* (useHistory) for self-owned state
 *   - `useEffect(fn, [])` — run once after first mount
 *   - Controlled form inputs (<select value={...} onChange={...}>)
 *   - Event handler on DOM events (`e.target.value`)
 *   - Inline style prop (`style={{ color: "var(--high)" }}`)
 *   - Multi-state conditional rendering (loading / error / empty / list)
 *   - List rendering with a stable `key` from backend id
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: the "History" tab on the right side of the page — a
 *   filterable list of past safety events (with risk-level and event-type
 *   dropdowns, a refresh button, and a count) that the operator can scroll
 *   through and click to open event details.
 * Backend: GET /api/events/history — called by the useHistory hook on
 *   mount and on every filter change (risk_level / event_type). Each row
 *   also renders an <AdminEventCard>, which opens an <EventDialog> on
 *   click (the dialog may in turn hit POST /api/events/{id}/feedback).
 */

// TEACH: `useEffect` is React's "do a side-effect after render" hook.
//        It runs after the DOM has been updated. The second argument is
//        the *dependency array*: React compares each item to the
//        previous render's values and re-runs the effect only if
//        something changed. `[]` = "run once, after the first mount".
import { useEffect, useState } from "react";

import { EventDialog } from "../../../shared/events";
import type { SafetyEvent } from "../../../shared/types/common";
import { ErrorList } from "../../../shared/ui";
// TEACH: `useHistory` is a *custom hook* — a plain function whose name
//        starts with `use` and which calls other hooks. Encapsulates
//        "fetch + filter + reload" logic so pages can just consume it.
import { useHistory } from "../hooks/useHistory";
// TEACH: `AdminEventCard` is re-exported from components/events/
//        via its own barrel index. See ../events/index.ts.
import { AdminEventCard } from "./AdminEventCard";
import styles from "./HistoryPanel.module.css";

// --- Render ---

// TEACH: No Props interface because this component takes zero props.
//        That's fine — keep the signature empty.
/**
 * HistoryPanel — self-contained list of past SafetyEvents with filters.
 *
 * UI connections:
 *   - Parent: rendered as a tab in AdminPage (alongside DetectionsPanel).
 *   - Child elements: two controlled <select>s + a "Refresh" button +
 *     count label in the filter bar; a scrolling list of
 *     <AdminEventCard> rows; an <EventDialog> modal for drill-down; an
 *     <ErrorList> surface for fetch failures.
 *   - CSS: HistoryPanel.module.css — `.filterBar`, `.select`,
 *     `.refreshBtn`, `.count`, `.list`, `.empty`.
 *
 * Backend endpoints: indirectly GET /api/events/history via the
 *   `useHistory` custom hook (on mount + on every filter change). The
 *   dialog opened from this panel can additionally submit feedback via
 *   POST /api/events/{id}/feedback.
 */
export function HistoryPanel() {
  // TEACH: The custom hook returns a big object of state + callbacks.
  //        We destructure everything we need in one line. If you want
  //        to know what each field is, open hooks/useHistory.ts.
  const { events, loading, error, filters, updateFilters, refresh } = useHistory();
  // Event-detail modal: clicking any AdminEventCard pops the same dialog
  // the validation page uses, so admins can scrub the annotated clip
  // straight from the history list.
  const [selectedEvent, setSelectedEvent] = useState<SafetyEvent | null>(null);

  // --- Effects ---

  // TEACH: Fire the initial fetch once after mount. Dep array `[]`
  //        means React runs this exactly once per component lifetime.
  //        NOTE: linters often warn about missing deps here — this is
  //        the classic "I really do mean only on mount" exception.
  //        `useEffect` can also return a cleanup function (called on
  //        unmount or before re-running); we don't need one here.
  useEffect(() => {
    refresh();
    // refresh is intentionally omitted: it changes when `filters` changes, but
    // `updateFilters` already calls `load(next)` — listing it here would double-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* --- Filter bar --- */}
      <div className={styles.filterBar}>
        {/* TEACH: Controlled input. React owns the value via
             `value={filters.risk_level}`; every keystroke/change fires
             `onChange`, which updates state, which re-renders with the
             new value. Never leave a controlled <select>'s `value`
             undefined — React will warn. */}
        <select
          className={styles.select}
          value={filters.risk_level}
          // TEACH: `e` is a React.ChangeEvent<HTMLSelectElement>.
          //        `e.target.value` is the selected <option>'s value.
          onChange={(e) => updateFilters({ risk_level: e.target.value })}
        >
          <option value="">All risks</option>
          <option value="high">High only</option>
          <option value="medium">Medium only</option>
          <option value="low">Low only</option>
        </select>
        <select
          className={styles.select}
          value={filters.event_type}
          onChange={(e) => updateFilters({ event_type: e.target.value })}
        >
          <option value="">All types</option>
          <option value="pedestrian_proximity">Pedestrian proximity</option>
          <option value="vehicle_close_interaction">Vehicle interaction</option>
        </select>
        {/* TEACH: Passing the `refresh` function directly to `onClick`.
             We could also write `onClick={() => refresh()}` — the
             difference is that the bare form reuses the same function
             reference across renders (slightly cheaper), while the
             inline arrow form creates a new function every render. For
             a plain DOM <button> that's almost never measurable; it
             matters only when passing callbacks into memoised children
             (React.memo / useCallback territory). */}
        <button type="button" className={styles.refreshBtn} onClick={refresh}>
          Refresh
        </button>
        <span className={styles.count}>{events.length} events</span>
      </div>
      {/* --- List + status messages --- */}
      <div className={styles.list}>
        {/* TEACH: Four mutually-exclusive states, rendered with `&&`.
             Order matters: loading wins over error which wins over
             empty which wins over the populated list. */}
        {loading && <div className={styles.empty}>Loading&hellip;</div>}
        {error && <ErrorList errors={[`Failed to load: ${error}`]} />}
        {!loading && !error && events.length === 0 && (
          <div className={styles.empty}>No events found</div>
        )}
        {/* TEACH: The list itself. `event_id` comes from the backend
             and is unique per event — an ideal `key`. Avoid index-based
             keys here: the list can reorder when filters change. */}
        {!loading &&
          events.map((ev) => (
            <AdminEventCard key={ev.event_id} event={ev} onSelect={setSelectedEvent} />
          ))}
      </div>
      <EventDialog event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
}
