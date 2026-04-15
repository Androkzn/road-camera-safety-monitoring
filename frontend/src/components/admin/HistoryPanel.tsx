import { useEffect } from "react";
import { useHistory } from "../../hooks/useHistory";
import { AdminEventCard } from "../events";
import styles from "./HistoryPanel.module.css";

export function HistoryPanel() {
  const { events, loading, error, filters, updateFilters, refresh } = useHistory();

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <div className={styles.filterBar}>
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
        <select
          className={styles.select}
          value={filters.event_type}
          onChange={(e) => updateFilters({ event_type: e.target.value })}
        >
          <option value="">All types</option>
          <option value="pedestrian_proximity">Pedestrian proximity</option>
          <option value="vehicle_close_interaction">Vehicle interaction</option>
        </select>
        <button className={styles.refreshBtn} onClick={refresh}>
          Refresh
        </button>
        <span className={styles.count}>{events.length} events</span>
      </div>
      <div className={styles.list}>
        {loading && (
          <div className={styles.empty}>Loading&hellip;</div>
        )}
        {error && (
          <div className={styles.empty} style={{ color: "var(--high)" }}>
            Failed to load: {error}
          </div>
        )}
        {!loading && !error && events.length === 0 && (
          <div className={styles.empty}>No events found</div>
        )}
        {!loading &&
          events.map((ev) => <AdminEventCard key={ev.event_id} event={ev} />)}
      </div>
    </div>
  );
}
