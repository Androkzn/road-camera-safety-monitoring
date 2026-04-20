/**
 * EventFilterBar — composite of the risk-level, event-type and
 * show-low-risk controls currently duplicated across the Dashboard
 * event feed and (soon) the Admin / Monitoring feeds.
 *
 * Keeps the controlled-component pattern: callers own the filter state
 * and pass setters in. The bar itself is stateless so it can be dropped
 * into any page without introducing a new state source.
 *
 * Usage:
 *   <EventFilterBar
 *     riskLevel={risk}
 *     onRiskLevelChange={setRisk}
 *     eventType={type}
 *     onEventTypeChange={setType}
 *     showLow={showLow}
 *     onShowLowChange={setShowLow}
 *     availableTypes={typesFromFeed}
 *     onClear={clearAll}
 *   />
 */
import { humanEventType } from "../lib/format";

import styles from "./EventFilterBar.module.css";

/**
 * Default event-type options. Matches the core conflict-detection
 * classes produced by `find_interactions` / `_emit_event`. Callers can
 * override via `availableTypes` — DashboardPage passes the set of types
 * actually observed in its current event buffer.
 */
const DEFAULT_TYPES: ReadonlyArray<string> = [
  "pedestrian_proximity",
  "vehicle_close_interaction",
  "hard_braking",
  "swerving",
];

interface EventFilterBarProps {
  riskLevel: string;
  onRiskLevelChange: (v: string) => void;
  eventType: string;
  onEventTypeChange: (v: string) => void;
  showLow: boolean;
  onShowLowChange: (v: boolean) => void;
  availableTypes?: ReadonlyArray<string>;
  onClear?: () => void;
  className?: string;
}

export function EventFilterBar({
  riskLevel,
  onRiskLevelChange,
  eventType,
  onEventTypeChange,
  showLow,
  onShowLowChange,
  availableTypes,
  onClear,
  className,
}: EventFilterBarProps) {
  const types = availableTypes ?? DEFAULT_TYPES;
  const hasFilters = riskLevel !== "" || eventType !== "";
  const rootClass = className ? `${styles.bar} ${className}` : styles.bar;

  return (
    <div className={rootClass}>
      <select
        className={styles.select}
        value={riskLevel}
        onChange={(e) => onRiskLevelChange(e.target.value)}
        aria-label="Filter by risk level"
      >
        <option value="">All risks</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>

      <select
        className={styles.select}
        value={eventType}
        onChange={(e) => onEventTypeChange(e.target.value)}
        aria-label="Filter by event type"
      >
        <option value="">All types</option>
        {types.map((t) => (
          <option key={t} value={t}>
            {humanEventType(t)}
          </option>
        ))}
      </select>

      {onClear && hasFilters && (
        <button type="button" className={styles.clearBtn} onClick={onClear}>
          Clear
        </button>
      )}

      <label className={styles.showLow}>
        <input
          type="checkbox"
          checked={showLow}
          onChange={(e) => onShowLowChange(e.target.checked)}
        />
        Show low risk
      </label>
    </div>
  );
}
