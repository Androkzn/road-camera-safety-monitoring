/**
 * MonitoringPage — watchdog incident queue (orchestrator).
 *
 * All logic for grouping/severity/sorting lives in `utils/incidents.ts`.
 * Each visual block (header, summary tiles, meta cards, immediate-actions
 * strip, selection toolbar, incident feed) is its own component under
 * `components/`. This file is just composition + local UI state.
 */

import { useCallback, useMemo, useState } from "react";

import { useEventStream } from "../../shared/hooks/useEventStream";
import { useLiveStatus } from "../../shared/hooks/useLiveStatus";
import { TopBar } from "../../shared/layout/TopBar";
import { useDialog } from "../../shared/ui";
import { useWatchdogCtx } from "../watchdog";

import {
  EventsPanel,
  IncidentFeed,
  ImmediateActions,
  MetaGrid,
  SelectionBar,
  SummaryGrid,
  SummaryHeader,
  ValidatorControl,
} from "./components";
import { useValidator } from "./hooks/useValidator";
import { buildIncidents } from "./utils/incidents";
import type { SevFilter } from "./types";

import styles from "./MonitoringPage.module.css";

export function MonitoringPage() {
  const { connected, events } = useEventStream();
  const { data: liveStatus } = useLiveStatus();
  const { status, findings, deleteFindings, clearAll } = useWatchdogCtx();
  const { status: validatorStatus } = useValidator();
  const validatorActive =
    !!validatorStatus?.enabled && !validatorStatus?.paused;

  const [filter, setFilter] = useState<SevFilter>("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const incidents = useMemo(() => buildIncidents(findings ?? []), [findings]);
  const filtered = useMemo(
    () =>
      filter === "all"
        ? incidents
        : incidents.filter((item) => item.severity === filter),
    [filter, incidents],
  );

  const errors = incidents.filter((i) => i.severity === "error").length;
  const warnings = incidents.filter((i) => i.severity === "warning").length;
  const infos = incidents.filter((i) => i.severity === "info").length;
  const totalIncidents = incidents.length;
  const repeatingIncidents = incidents.filter((i) => i.count > 1).length;
  const actionQueue = filtered.filter((i) => i.severity !== "info").slice(0, 3);

  const toggle = (sev: SevFilter) =>
    setFilter((prev) => (prev === sev ? "all" : sev));

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelected(new Set(filtered.map((i) => i.id)));
  }, [filtered]);

  const handleDeleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const keys = filtered
        .filter((i) => selected.has(i.id))
        .flatMap((i) => i.rawKeys);
      await deleteFindings(Array.from(new Set(keys)));
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [deleteFindings, exitSelectMode, filtered, selected]);

  const dialog = useDialog();
  const handleClearAll = useCallback(async () => {
    const ok = await dialog.confirm({
      title: "Clear all findings?",
      message:
        totalIncidents > 0
          ? `This deletes all ${totalIncidents} incident${totalIncidents === 1 ? "" : "s"} from the watchdog queue. The action can't be undone.`
          : "This clears the watchdog queue. The action can't be undone.",
      okLabel: "Clear all",
      cancelLabel: "Cancel",
      variant: "danger",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await clearAll();
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [clearAll, exitSelectMode, dialog, totalIncidents]);

  const sourceName = liveStatus?.source ?? "—";

  return (
    <>
      <TopBar
        sourceName={sourceName}
        connected={connected}
        errorCount={status?.by_severity?.error ?? 0}
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
          />

          <SummaryGrid
            errors={errors}
            warnings={warnings}
            infos={infos}
            totalIncidents={totalIncidents}
            filter={filter}
            onToggle={toggle}
            onShowAll={() => setFilter("all")}
          />

          <MetaGrid
            status={status}
            filteredCount={filtered.length}
            repeatingIncidents={repeatingIncidents}
          />

          <ValidatorControl />
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
          <EventsPanel
            events={events}
            findings={findings ?? []}
            validatorEnabled={validatorActive}
            filter={filter}
          />
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
