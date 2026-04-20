/**
 * MonitoringPage — watchdog incident queue (composition shell).
 *
 * All grouping/severity/sorting lives in `utils/incidents.ts`.
 * Filtering, selection, and bulk actions live in `useMonitoringIncidents`.
 * Each visual block is its own component under `components/`.
 */

import { useEventStreamConnection } from "../../shared/hooks/useEventStream";
import { useLiveStatus } from "../../shared/hooks/useLiveStatus";
import { PageChrome } from "../../shared/layout/PageChrome";
import { useWatchdogCtx } from "../watchdog";

import {
  IncidentFeed,
  ImmediateActions,
  MetaGrid,
  SelectionBar,
  SummaryGrid,
  SummaryHeader,
} from "./components";
import { useMonitoringIncidents } from "./hooks/useMonitoringIncidents";

import styles from "./MonitoringPage.module.css";

export function MonitoringPage() {
  const connected = useEventStreamConnection();
  const { data: liveStatus } = useLiveStatus();
  const { status, findings, deleteFindings, clearAll } = useWatchdogCtx();

  const {
    filter,
    showLow,
    setShowLow,
    selectMode,
    setSelectMode,
    selected,
    setSelected,
    deleting,
    filtered,
    errors,
    warnings,
    infos,
    totalIncidents,
    repeatingIncidents,
    actionQueue,
    toggle,
    exitSelectMode,
    toggleSelect,
    selectAllVisible,
    handleDeleteSelected,
    handleClearAll,
  } = useMonitoringIncidents({ findings, deleteFindings, clearAll });

  const sourceName = liveStatus?.source ?? "—";

  return (
    <>
      <PageChrome
        page="monitoring"
        sourceName={sourceName}
        connected={connected}
      />

      <div className={styles.page}>
        <div className={styles.header}>
          <SummaryHeader
            selectMode={selectMode}
            totalIncidents={totalIncidents}
            filteredCount={filtered.length}
            deleting={deleting}
            onEnterSelect={() => setSelectMode(true)}
            onClearAll={handleClearAll}
          >
            <label className={styles.showLow}>
              <input
                type="checkbox"
                checked={showLow}
                onChange={(e) => setShowLow(e.target.checked)}
              />
              Show low severity
            </label>
          </SummaryHeader>

          <SummaryGrid
            errors={errors}
            warnings={warnings}
            infos={infos}
            totalIncidents={totalIncidents}
            filter={filter}
            onToggle={toggle}
            onShowAll={() => toggle("all")}
          />

          <MetaGrid
            status={status}
            filteredCount={filtered.length}
            repeatingIncidents={repeatingIncidents}
          />
        </div>

        {selectMode && (
          <SelectionBar
            selectedCount={selected.size}
            filteredCount={filtered.length}
            deleting={deleting}
            onSelectAll={selectAllVisible}
            onDeselectAll={() => setSelected(new Set())}
            onDeleteSelected={handleDeleteSelected}
            onCancel={exitSelectMode}
          />
        )}

        <div className={styles.content}>
          <ImmediateActions incidents={actionQueue} />
          <IncidentFeed
            filter={filter}
            status={status}
            incidents={filtered}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={toggleSelect}
            onDelete={(rawKeys) => deleteFindings(rawKeys)}
          />
        </div>
      </div>
    </>
  );
}
