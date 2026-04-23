/**
 * ImmediateActions — top-3 non-info incidents as quick-jump buttons.
 * Clicking scrolls the matching IncidentCard into view.
 *
 * Acts as a cheat-sheet: operator lands on the page, sees at most 3
 * high-severity things to handle now, can jump straight to each card.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: the "Immediate Actions" row of up to three quick-jump
 *   tiles sitting just above the incident feed; each tile scrolls the
 *   matching card into view when clicked.
 */
import { formatRelative } from "../utils/formatting";
import type { WatchdogIncident } from "../types";

import styles from "../MonitoringPage.module.css";

/** Props — receives the pre-trimmed top-3 list from the parent. */
interface ImmediateActionsProps {
  incidents: WatchdogIncident[];
}

/**
 * Render quick-jump tiles. Returning `null` tells React to render
 * nothing — the whole section collapses when there is nothing urgent.
 */
export function ImmediateActions({ incidents }: ImmediateActionsProps) {
  if (incidents.length === 0) return null;
  return (
    <section className={styles.queueSection}>
      <div className={styles.sectionHeader}>Immediate Actions</div>
      <div className={styles.queueGrid}>
        {incidents.map((incident) => (
          <button
            type="button"
            key={incident.id}
            className={`${styles.queueCard} ${styles[incident.severity]}`}
            // Imperative DOM work (scrolling) is fine inside an event
            // handler — React only owns the render cycle. `el?.scroll…`
            // guards against the card being filtered out of the feed.
            onClick={() => {
              const el = document.getElementById(`incident-${incident.id}`);
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            <span className={styles.queueSeverity}>{incident.severity.toUpperCase()}</span>
            <span className={styles.queueTitle}>{incident.title}</span>
            <span className={styles.queueNext}>
              {incident.latest.suggestion || incident.latest.detail}
            </span>
            <span className={styles.queueMeta}>
              {incident.owner || incident.category} • last seen {formatRelative(incident.lastSeen)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
