/**
 * useLiveSources — **thin aggregator kept for source-compat.**
 *
 * Composes `useLiveSourcesList`, `useStreamRegistry`, and a tiny inline
 * layer of per-id legacy wrappers so existing consumers (AdminPage,
 * SettingsPage) keep working without a prop-surface change.
 *
 * New consumers should import the narrower hooks directly:
 *   - `useLiveSourcesList(pollMs?)` — just the list + refresh.
 *   - `useStreamControl(sourceId)` — per-source start/pause/detection,
 *     mounted inside a tile component. Derives `busy` from the
 *     mutation's `isPending`.
 *   - `useStreamRegistry()` — add / remove.
 *
 * The per-id `start` / `pause` / `setDetection` / `remove` helpers exposed
 * here are intentionally coarse — they fire one-shot mutations through
 * the shared `adminApi` and invalidate the sources list on settle. That
 * matches the new mutation-centric model but can't share React Query's
 * `isPending` tracking across components (each invocation is a fresh
 * closure), which is why they don't fill in `busyById` anymore. Tiles
 * that care about per-slot busy state should mount `useStreamControl`
 * directly instead of reading `busyById` through here.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the back-compat hook that
 *   feeds the page header and the video-tile grid with the list of
 *   cameras and the start/pause/detection/add/remove actions.
 * Backend: GET/POST/DELETE /api/live/sources and the per-slot
 *   start|pause|detection sub-routes.
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { dialog } from "../../../shared/ui";
import type { LiveSourceStatus, LiveSourcesResponse } from "../../../shared/types/common";

import { adminApi, adminQueryKeys } from "../api";
import { useLiveSourcesList } from "./useLiveSourcesList";
import { useStreamRegistry } from "./useStreamRegistry";

/** Legacy busy union, re-exported for callers that still type against it. */
export type BusyAction = "starting" | "pausing" | "removing";

export interface UseLiveSourcesResult {
  sources: LiveSourceStatus[];
  primaryId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  setDetection: (id: string, enabled: boolean) => Promise<void>;
  add: (input: { url: string; name?: string }) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: string) => Promise<void>;
  /** Legacy busy-map. Populated only for `remove` (via registry) now;
   *  `start` / `pause` busy state is no longer tracked here — mount
   *  `useStreamControl(id)` inside a tile if you need it. */
  busyById: Record<string, BusyAction | null>;
}

export function useLiveSources(
  refetchIntervalMs: number = POLL_INTERVAL_MS.liveSources,
): UseLiveSourcesResult {
  const qc = useQueryClient();
  const list = useLiveSourcesList(refetchIntervalMs);
  const registry = useStreamRegistry();

  // Track the ids whose legacy start/pause wrappers are mid-flight so
  // `busyById` keeps reporting "starting" / "pausing" for callers that
  // still read it through the aggregator. Tiles that render through
  // `useStreamControl` read the authoritative `isPending` directly and
  // ignore this map entirely.
  const [legacyBusy, setLegacyBusy] = useState<Record<string, "starting" | "pausing" | null>>({});
  const setLegacy = (id: string, v: "starting" | "pausing" | null) =>
    setLegacyBusy((prev) => ({ ...prev, [id]: v }));

  const invalidateList = useCallback(() => {
    void qc.invalidateQueries({ queryKey: adminQueryKeys.liveSources });
  }, [qc]);

  const patchRunning = useCallback(
    (id: string, running: boolean) => {
      qc.setQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources, (prev) =>
        prev
          ? {
              ...prev,
              sources: prev.sources.map((s) => (s.id === id ? { ...s, running } : s)),
            }
          : prev,
      );
    },
    [qc],
  );

  const patchDetection = useCallback(
    (id: string, enabled: boolean) => {
      qc.setQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources, (prev) =>
        prev
          ? {
              ...prev,
              sources: prev.sources.map((s) =>
                s.id === id ? { ...s, detection_enabled: enabled } : s,
              ),
            }
          : prev,
      );
    },
    [qc],
  );

  const start = useCallback(
    async (id: string) => {
      setLegacy(id, "starting");
      patchRunning(id, true);
      try {
        await adminApi.startLiveSource(id);
      } catch (exc) {
        patchRunning(id, false);
        void dialog.alert({
          title: "Start stream failed",
          message: (exc as Error)?.message ?? "unknown error",
          variant: "danger",
        });
      } finally {
        setLegacy(id, null);
        invalidateList();
      }
    },
    [invalidateList, patchRunning],
  );

  const pause = useCallback(
    async (id: string) => {
      setLegacy(id, "pausing");
      patchRunning(id, false);
      try {
        await adminApi.pauseLiveSource(id);
      } catch (exc) {
        patchRunning(id, true);
        void dialog.alert({
          title: "Pause stream failed",
          message: (exc as Error)?.message ?? "unknown error",
          variant: "danger",
        });
      } finally {
        setLegacy(id, null);
        invalidateList();
      }
    },
    [invalidateList, patchRunning],
  );

  const setDetection = useCallback(
    async (id: string, enabled: boolean) => {
      patchDetection(id, enabled);
      try {
        await adminApi.setLiveSourceDetection(id, enabled);
      } finally {
        invalidateList();
      }
    },
    [invalidateList, patchDetection],
  );

  // Compose the busy map from the two sources we still care about here.
  const busyById: Record<string, BusyAction | null> = {};
  for (const [id, v] of Object.entries(legacyBusy)) {
    if (v) busyById[id] = v;
  }
  for (const id of Object.keys(registry.removingById)) {
    if (registry.removingById[id]) busyById[id] = "removing";
  }

  return {
    sources: list.sources,
    primaryId: list.primaryId,
    loading: list.loading,
    error: list.error,
    refresh: list.refresh,
    start,
    pause,
    setDetection,
    add: registry.add,
    remove: registry.remove,
    busyById,
  };
}
