/**
 * useMonitoringIncidents — owns filtering, selection, and bulk-action
 * orchestration so MonitoringPage stays a thin composition shell.
 */
import { useCallback, useMemo, useState } from "react";

import { useDialog } from "../../../shared/ui";
import type { WatchdogFinding } from "../../../shared/types/common";

import type { SevFilter, WatchdogIncident } from "../types";
import { buildIncidents } from "../utils/incidents";

interface UseMonitoringIncidentsOpts {
  findings: WatchdogFinding[] | null;
  deleteFindings: (keys: string[]) => Promise<void>;
  clearAll: () => Promise<void>;
}

export function useMonitoringIncidents({
  findings,
  deleteFindings,
  clearAll,
}: UseMonitoringIncidentsOpts) {
  const [filter, setFilter] = useState<SevFilter>("all");
  const [showLow, setShowLow] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const dialog = useDialog();

  const systemFindings = useMemo(
    () => (findings ?? []).filter((f) => f.category !== "validator"),
    [findings],
  );
  const incidents = useMemo(
    () => buildIncidents(systemFindings),
    [systemFindings],
  );
  const filtered = useMemo(() => {
    let list = incidents;
    if (!showLow && filter !== "info") {
      list = list.filter((item) => item.severity !== "info");
    }
    if (filter !== "all") {
      list = list.filter((item) => item.severity === filter);
    }
    return list;
  }, [filter, incidents, showLow]);

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
    setSelected(new Set(filtered.map((i: WatchdogIncident) => i.id)));
  }, [filtered]);

  const handleDeleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const keys = filtered
        .filter((i: WatchdogIncident) => selected.has(i.id))
        .flatMap((i: WatchdogIncident) => i.rawKeys);
      await deleteFindings(Array.from(new Set(keys)));
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [deleteFindings, exitSelectMode, filtered, selected]);

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

  return {
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
    deleteFindings,
  };
}
