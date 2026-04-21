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
 *
 * React/TS concepts first introduced in this file:
 *   - `useMutation` — TanStack Query's counterpart to `useQuery`, for
 *     writes. Provides `mutate()`, `isPending`, `onMutate`/`onError`/
 *     `onSettled` hooks for optimistic UI.
 *   - `useQueryClient` — handle to the shared query cache, used here to
 *     read-then-patch cached data before the server round-trip.
 *   - Generic type arguments on `useMutation<TData, TError, TVars, TCtx>`.
 *   - Optimistic updates + rollback via a per-mutation `onMutate` ctx.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the actions hook behind
 *   the start, pause, and "detection on/off" toggle buttons on each
 *   individual video tile.
 * Backend: POST /api/live/sources/{id}/start, /pause, /detection.
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

// TEACH: The shape of the context object that each `onMutate` returns
// and `onError`/`onSettled` receive. It carries the snapshot we took
// before the optimistic patch, so we can roll back cleanly on failure.
interface OptimisticCtx {
  previous: LiveSourcesResponse | undefined;
}

/**
 * Wire up lifecycle mutations for one source slot (by id).
 * Returns typed `start`/`pause`/`setDetection` callbacks plus a `busy`
 * union and individual `isPending` flags for fine-grained UI states.
 */
export function useStreamControl(sourceId: string): UseStreamControlResult {
  // `useQueryClient` exposes the same cache `useQuery` reads/writes.
  const qc = useQueryClient();

  // Snapshot + optimistic patch: flip `running` for THIS source in the
  // cached list, return the pre-patch snapshot so we can restore it.
  const patchRunning = (running: boolean): OptimisticCtx => {
    const previous = qc.getQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources);
    qc.setQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources, (prev) =>
      prev
        ? {
            ...prev,
            sources: prev.sources.map((s) => (s.id === sourceId ? { ...s, running } : s)),
          }
        : prev,
    );
    return { previous };
  };

  const patchDetection = (enabled: boolean): OptimisticCtx => {
    const previous = qc.getQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources);
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

  // TEACH: `useMutation<TData, TError, TVars, TCtx>` generics:
  //   TData   — what mutationFn resolves with (we ignore it → unknown).
  //   TError  — error class the handlers receive.
  //   TVars   — argument type of `.mutate(…)` (void → no argument).
  //   TCtx    — context object returned by onMutate and fed to
  //             onError/onSettled for rollback.
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

  const detectionMutation = useMutation<unknown, Error, boolean, OptimisticCtx>({
    mutationFn: (enabled) => adminApi.setLiveSourceDetection(sourceId, enabled),
    onMutate: (enabled) => patchDetection(enabled),
    onError: (_exc, _v, ctx) => rollback(ctx),
    onSettled: invalidateList,
  });

  // Collapse two `isPending` booleans into a single union so templates
  // can render "Starting…" / "Pausing…" labels off one variable.
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
