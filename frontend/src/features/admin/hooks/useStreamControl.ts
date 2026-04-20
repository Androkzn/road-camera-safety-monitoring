/**
 * useStreamControl — per-source lifecycle mutations for one perception slot.
 *
 * Wires `start` / `pause` / `setDetection` as `useMutation`s. Each one
 *   1. optimistically mutates the cached `GET /api/live/sources` list,
 *   2. invalidates the list query on success so the next frame reflects
 *      authoritative server state,
 *   3. rolls back its optimistic patch on error and surfaces a dialog.
 *
 * `busy` derives from the mutations' `isPending` flags — no hand-rolled
 * busy-map, no safety-belt timeouts. React Query owns the "in-flight"
 * bookkeeping.
 *
 * NOTE: this hook is meant to be called from inside a tile component
 * (scoped to one source id). The registry-level restart/add/remove
 * helpers live in `useStreamRegistry`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { dialog } from "../../../shared/ui";
import type { LiveSourcesResponse } from "../../../shared/types/common";

import { adminApi, adminQueryKeys } from "../api";

/** Action the slot is currently performing. Matches the legacy public type
 *  exported by `useLiveSources` for source-compat. */
export type StreamBusyAction = "starting" | "pausing" | null;

export interface UseStreamControlResult {
  start: () => void;
  pause: () => void;
  setDetection: (enabled: boolean) => void;
  /** Resolves to the same union as the legacy `busyById[id]` value so the
   *  aggregator can project it back into a map without type gymnastics. */
  busy: StreamBusyAction;
  startPending: boolean;
  pausePending: boolean;
  detectionPending: boolean;
}

interface OptimisticCtx {
  previous: LiveSourcesResponse | undefined;
}

export function useStreamControl(sourceId: string): UseStreamControlResult {
  const qc = useQueryClient();

  const patchRunning = (running: boolean): OptimisticCtx => {
    const previous = qc.getQueryData<LiveSourcesResponse>(
      adminQueryKeys.liveSources,
    );
    qc.setQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources, (prev) =>
      prev
        ? {
            ...prev,
            sources: prev.sources.map((s) =>
              s.id === sourceId ? { ...s, running } : s,
            ),
          }
        : prev,
    );
    return { previous };
  };

  const patchDetection = (enabled: boolean): OptimisticCtx => {
    const previous = qc.getQueryData<LiveSourcesResponse>(
      adminQueryKeys.liveSources,
    );
    qc.setQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources, (prev) =>
      prev
        ? {
            ...prev,
            sources: prev.sources.map((s) =>
              s.id === sourceId ? { ...s, detection_enabled: enabled } : s,
            ),
          }
        : prev,
    );
    return { previous };
  };

  const rollback = (ctx: OptimisticCtx | undefined) => {
    if (ctx?.previous) {
      qc.setQueryData(adminQueryKeys.liveSources, ctx.previous);
    }
  };

  const invalidateList = () => {
    void qc.invalidateQueries({ queryKey: adminQueryKeys.liveSources });
  };

  const startMutation = useMutation<unknown, Error, void, OptimisticCtx>({
    mutationFn: () => adminApi.startLiveSource(sourceId),
    onMutate: () => patchRunning(true),
    onError: (exc, _v, ctx) => {
      rollback(ctx);
      void dialog.alert({
        title: "Start stream failed",
        message: exc?.message ?? "unknown error",
        variant: "danger",
      });
    },
    onSettled: invalidateList,
  });

  const pauseMutation = useMutation<unknown, Error, void, OptimisticCtx>({
    mutationFn: () => adminApi.pauseLiveSource(sourceId),
    onMutate: () => patchRunning(false),
    onError: (exc, _v, ctx) => {
      rollback(ctx);
      void dialog.alert({
        title: "Pause stream failed",
        message: exc?.message ?? "unknown error",
        variant: "danger",
      });
    },
    onSettled: invalidateList,
  });

  const detectionMutation = useMutation<unknown, Error, boolean, OptimisticCtx>(
    {
      mutationFn: (enabled) =>
        adminApi.setLiveSourceDetection(sourceId, enabled),
      onMutate: (enabled) => patchDetection(enabled),
      onError: (_exc, _v, ctx) => rollback(ctx),
      onSettled: invalidateList,
    },
  );

  const busy: StreamBusyAction = startMutation.isPending
    ? "starting"
    : pauseMutation.isPending
      ? "pausing"
      : null;

  return {
    start: () => startMutation.mutate(),
    pause: () => pauseMutation.mutate(),
    setDetection: (enabled: boolean) => detectionMutation.mutate(enabled),
    busy,
    startPending: startMutation.isPending,
    pausePending: pauseMutation.isPending,
    detectionPending: detectionMutation.isPending,
  };
}
