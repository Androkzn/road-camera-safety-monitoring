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
 *
 * --- UI mapping ---
 * Used on: DashboardPage, AdminPage, MonitoringPage — anywhere an event
 *   feed is shown.
 * UI element: horizontal filter bar above an event feed with two select
 *   dropdowns (risk level, event type), a "Show low risk" checkbox, and
 *   an optional Clear button when any filter is active.
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

// Props are fully controlled: empty-string sentinel values mean "no
// filter applied". `availableTypes` overrides DEFAULT_TYPES so the
// dropdown can shrink to only the event classes actually present in
// the caller's current feed. `onClear` is optional — the Clear button
// only renders when both the callback and at least one active filter
// exist (see `hasFilters` below).
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

/**
 * Renders the horizontal filter bar: risk-level <select>, event-type
 * <select>, optional Clear button, and a "Show low risk" checkbox.
 * Purely presentational — every state change delegates to the setter
 * props passed by the parent feature page.
 */
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
  // Fall back to the hard-coded default event-type list when the caller
  // doesn't narrow the dropdown to its actual feed contents.
  const types = availableTypes ?? DEFAULT_TYPES;
  // "Any filter active?" — drives visibility of the Clear button below.
  // Empty string is the sentinel for "no filter" on both selects.
  const hasFilters = riskLevel !== "" || eventType !== "";
  // Merge caller className with the module style so parents can tweak
  // layout (e.g. widen on Admin, compact on Dashboard) without CSS hacks.
  const rootClass = className ? `${styles.bar} ${className}` : styles.bar;

  return (
    <div className={rootClass}>
      {/* Risk-level select. aria-label (not a visible <label>) because
          the bar is dense — screen readers still get a clear purpose. */}
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

      {/* Event-type select. Raw values are snake_case backend identifiers;
          humanEventType() converts them to display strings
          ("pedestrian_proximity" -> "Pedestrian proximity"). */}
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

      {/* Clear appears only when something is actually filtered — avoids
          a dead button when the bar is in its default state. */}
      {onClear && hasFilters && (
        <button type="button" className={styles.clearBtn} onClick={onClear}>
          Clear
        </button>
      )}

      {/* "Show low risk" is a separate gate from the risk-level <select>:
          the feed hides low-severity events by default to reduce noise,
          and this checkbox is the explicit opt-in. Rendered as a
          <label> wrapping the <input> so the whole row is clickable. */}
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
