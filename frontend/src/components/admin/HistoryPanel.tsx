/**
 * HistoryPanel.tsx — filterable list of historical safety events.
 *
 * What it does:
 *   Shows a filter bar (risk level, event type, refresh button, total count)
 *   and a scrollable list of `<AdminEventCard>` entries. Displays loading,
 *   error, and empty states.
 *
 * Purpose:
 *   Lets an operator browse and filter past safety events recorded by the
 *   pipeline, from the Admin page's sidebar.
 *
 * How it works:
 *   - `useHistory()` is a custom hook that returns events, loading/error
 *     flags, current filter state, and `updateFilters` / `refresh` helpers.
 *   - `useEffect(() => { refresh(); }, [])`: a React "side effect" hook —
 *     this one runs once on mount (empty dep array `[]`) to load data.
 *   - Each `<select>` is controlled: its `value` is tied to state, and
 *     `onChange` calls `updateFilters` which re-fetches with new params.
 *   - Conditional rendering chains (`loading && ...`, `error && ...`,
 *     `!loading && events.map(...)`) show exactly one state at a time.
 *   - `events.map((ev) => <AdminEventCard key={ev.event_id} .../>)` loops
 *     and gives each card a stable `key` so React can track list updates.
 *
 * Connects to:
 *   - Backend: via `useHistory` hook → `GET /api/live/events` with query
 *     params `risk_level`, `event_type`, `limit`.
 *   - UI: rendered by `pages/AdminPage.tsx` inside the "History" tab of the
 *     sidebar `<TabBar>`.
 */
import { useEffect } from "react";
import { useHistory } from "../../hooks/useHistory";
import { AdminEventCard } from "../events";
import styles from "./HistoryPanel.module.css";

// Renders the "History" tab content inside the Admin page sidebar: a filter
// bar at the top and a scrollable list of past event cards below it.
export function HistoryPanel() {
  // useHistory is a custom hook that owns fetched events, loading/error flags,
  // the current filter object, plus helpers to update filters and re-fetch.
  const { events, loading, error, filters, updateFilters, refresh } = useHistory();

  // useEffect = "run this after render". Empty `[]` dependency array means
  // run exactly once when the component first mounts — here to load history.
  useEffect(() => {
    refresh();
  }, []);

  return (
    // Wrapper — the whole History tab body
    <div>
      {/* Top filter bar: two dropdowns + Refresh button + event count */}
      <div className={styles.filterBar}>
        {/* Risk-level dropdown (All/High/Medium/Low). It's "controlled": value is bound to filters.risk_level, change triggers a refetch. */}
        <select
          className={styles.select}
          value={filters.risk_level}
          onChange={(e) => updateFilters({ risk_level: e.target.value })}
        >
          <option value="">All risks</option>
          <option value="high">High only</option>
          <option value="medium">Medium only</option>
          <option value="low">Low only</option>
        </select>
        {/* Event-type dropdown (All/Pedestrian proximity/Vehicle interaction) */}
        <select
          className={styles.select}
          value={filters.event_type}
          onChange={(e) => updateFilters({ event_type: e.target.value })}
        >
          <option value="">All types</option>
          <option value="pedestrian_proximity">Pedestrian proximity</option>
          <option value="vehicle_close_interaction">Vehicle interaction</option>
        </select>
        {/* Refresh button — re-runs the fetch with current filters */}
        <button className={styles.refreshBtn} onClick={refresh}>
          Refresh
        </button>
        {/* Right-side count badge, e.g. "12 events" */}
        <span className={styles.count}>{events.length} events</span>
      </div>
      {/* Scrollable list region below the filter bar */}
      <div className={styles.list}>
        {/* Loading placeholder — shown only while a fetch is in flight. `{loading && <X/>}` means "render X only when loading is truthy". */}
        {loading && (
          <div className={styles.empty}>Loading&hellip;</div>
        )}
        {/* Error message — red text when the fetch failed */}
        {error && (
          <div className={styles.empty} style={{ color: "var(--high)" }}>
            Failed to load: {error}
          </div>
        )}
        {/* Empty-state message — shown when the fetch succeeded but returned no events */}
        {!loading && !error && events.length === 0 && (
          <div className={styles.empty}>No events found</div>
        )}
        {/* The actual vertical list of event cards. `.map` loops the array; `key` must be stable per item so React can diff the list efficiently. */}
        {!loading &&
          events.map((ev) => <AdminEventCard key={ev.event_id} event={ev} />)}
      </div>
    </div>
  );
}
