/**
 * SummaryGrid — the four-tile severity row. Click to filter; click the
 * active tile to reset to "all".
 *
 * Three severity counters + a total. Lives above the incident feed and
 * is the primary filter control on this page.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: the row of four big filter tiles near the top of the page
 *   (Errors / Warnings / Info / Incidents); clicking one filters the
 *   feed to that severity, clicking the active one resets to "all".
 */
import type { SevFilter } from "../types";

import styles from "../MonitoringPage.module.css";
import { FilterTile } from "./FilterTile";

/**
 * Props: three counts + total, plus the current filter and two callbacks.
 * `onToggle(sev)` flips to `sev` (or off if already active); `onShowAll`
 * explicitly sets the filter back to "all".
 */
interface SummaryGridProps {
  errors: number;
  warnings: number;
  infos: number;
  totalIncidents: number;
  filter: SevFilter;
  onToggle: (sev: SevFilter) => void;
  onShowAll: () => void;
}

/** Render four FilterTiles and forward clicks to the parent handlers. */
export function SummaryGrid({
  errors,
  warnings,
  infos,
  totalIncidents,
  filter,
  onToggle,
  onShowAll,
}: SummaryGridProps) {
  return (
    <div className={styles.summaryGrid}>
      <FilterTile
        label="Errors"
        value={errors}
        variant="error"
        active={filter === "error"}
        onClick={() => onToggle("error")}
      />
      <FilterTile
        label="Warnings"
        value={warnings}
        variant="warning"
        active={filter === "warning"}
        onClick={() => onToggle("warning")}
      />
      <FilterTile
        label="Info"
        value={infos}
        variant="info"
        active={filter === "info"}
        onClick={() => onToggle("info")}
      />
      <FilterTile
        label="Incidents"
        value={totalIncidents}
        variant="total"
        active={filter === "all"}
        onClick={onShowAll}
      />
    </div>
  );
}
