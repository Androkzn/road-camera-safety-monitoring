/**
 * IncidentFeed — full incident list section, including the empty state.
 *
 * Renders a list of `IncidentCard`s. The list is already fingerprint-grouped
 * and sorted upstream (severity → priority → recency); this component just
 * paints it and picks the right empty-state message.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: the scrolling incident feed at the bottom of the page —
 *   the "Showing N incident groups" header, the empty-state message, and
 *   the stack of IncidentCards underneath.
 */
import type { WatchdogStatus } from "../../../shared/types/common";
import type { SevFilter, WatchdogIncident } from "../types";

import { IncidentCard } from "./IncidentCard";
import styles from "../MonitoringPage.module.css";

/**
 * Props shape. In React, every piece of data a parent passes to a child
 * is a "prop" — this interface lists them and lets TS enforce the contract.
 * `Set<string>` is a JS built-in Set typed to hold strings (O(1) lookup).
 * The `(id: string) => void` syntax is a function type.
 */
interface IncidentFeedProps {
  filter: SevFilter;
  status: WatchdogStatus | null;
  incidents: WatchdogIncident[];
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onDelete: (rawKeys: string[]) => void;
}

/**
 * Render the feed. Uses `: IncidentFeedProps` on the destructured argument
 * so TypeScript checks every prop at every call site.
 */
export function IncidentFeed({
  filter,
  status,
  incidents,
  selectMode,
  selected,
  onToggleSelect,
  onDelete,
}: IncidentFeedProps) {
  return (
    <section className={styles.feedSection}>
      <div className={styles.sectionHeader}>
        {filter === "all"
          ? `Showing ${incidents.length} incident groups`
          : `Showing ${incidents.length} ${filter} incident${incidents.length !== 1 ? "s" : ""}`}
      </div>

      {incidents.length === 0 && (
        <div className={styles.emptyList}>
          {filter !== "all"
            ? `No ${filter} incidents in the recent window`
            : status?.run_count
              ? "No active issues found in the recent window"
              : "Waiting for the first watchdog check…"}
        </div>
      )}

      <div className={styles.incidentList}>
        {/* .map() over incidents to generate one child per incident. The
            `key` prop lets React match items across renders — without it
            React would re-mount every card on every update. Use a STABLE
            id (not the array index) when the list can reorder. */}
        {incidents.map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            selectMode={selectMode}
            isSelected={selected.has(incident.id)}
            onToggleSelect={onToggleSelect}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  );
}
