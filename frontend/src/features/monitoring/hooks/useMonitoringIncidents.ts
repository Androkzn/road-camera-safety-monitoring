/**
 * useMonitoringIncidents — owns filtering, selection, and bulk-action
 * orchestration so MonitoringPage stays a thin composition shell.
 *
 * Takes the raw findings stream, fingerprint-groups it into incidents,
 * applies the current filter, and exposes everything the page needs in
 * one return object. This is where the "incident queue, not log tail"
 * mental model shows up in the UI layer.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: No direct UI — drives the four filter tiles, the bulk-select
 *   toolbar, the "Show low severity" checkbox, the Immediate Actions
 *   top-3 list, and the filtered incident feed.
 * Backend: DELETE on watchdog findings via the watchdog feature context
 *   (deleteFindings / clearAll callbacks supplied by the page).
 */
// useCallback: memoise function identity. useMemo: memoise computed value.
// useState: basic local state. All three accept a "deps" array that
// controls when the memoised result is recomputed.
import { useCallback, useMemo, useState } from "react";

import { useDialog } from "../../../shared/ui";
import type { WatchdogFinding } from "../../../shared/types/common";

import type { SevFilter, WatchdogIncident } from "../types";
import { buildIncidents } from "../utils/incidents";

/** Inputs. `Promise<void>` functions are async operations with no return value. */
interface UseMonitoringIncidentsOpts {
  findings: WatchdogFinding[] | null;
  deleteFindings: (keys: string[]) => Promise<void>;
  clearAll: () => Promise<void>;
}

/**
 * The feature's page-level controller hook. Returns the full view-model:
 * filter/selection state + all derived counts + callbacks for the UI.
 */
export function useMonitoringIncidents({
  findings,
  deleteFindings,
  clearAll,
}: UseMonitoringIncidentsOpts) {
  // Each useState returns `[value, setValue]`. The generic (e.g. <SevFilter>)
  // constrains what values the setter accepts — "all", "error", etc.
  const [filter, setFilter] = useState<SevFilter>("all");
  const [showLow, setShowLow] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  // A Set gives O(1) lookup ("is this id selected?") and natural dedup.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Dialog context from shared/ui — a custom hook that returns an imperative
  // `confirm(...)` promise so we don't have to juggle open/close state.
  const dialog = useDialog();

  // useMemo caches derived values so we don't redo expensive work on every
  // render. The dep array controls cache invalidation — recompute only
  // when `findings` changes.
  const systemFindings = useMemo(
    () => (findings ?? []).filter((f) => f.category !== "validator"),
    [findings],
  );
  // Fingerprint-group and sort. This is where the log-tail → incident-queue
  // transformation happens (see utils/incidents.ts).
  const incidents = useMemo(() => buildIncidents(systemFindings), [systemFindings]);
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

  // Quick counts for the summary tiles. Not memoised because each one is a
  // single O(n) pass over an already-small array — cheaper than the memo book-keeping.
  const errors = incidents.filter((i) => i.severity === "error").length;
  const warnings = incidents.filter((i) => i.severity === "warning").length;
  const infos = incidents.filter((i) => i.severity === "info").length;
  const totalIncidents = incidents.length;
  const repeatingIncidents = incidents.filter((i) => i.count > 1).length;
  // Top-3 for the "Immediate Actions" strip above the feed.
  const actionQueue = filtered.filter((i) => i.severity !== "info").slice(0, 3);

  // Click a tile twice to reset — clicking the active filter switches back to "all".
  const toggle = (sev: SevFilter) => setFilter((prev) => (prev === sev ? "all" : sev));

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

  // Bulk delete: flatten every selected incident's rawKeys (one incident =
  // many raw finding rows), dedupe via a Set, send to the server, then
  // exit select mode. `try/finally` guarantees `deleting` is reset even
  // if the API call throws.
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

  // Destructive action — always funnel through a confirm dialog.
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
