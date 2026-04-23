/**
 * useStreamRegistry — registry-wide mutations that don't target a single
 * slot: `add`, `remove`, plus a bulk start/pause fan-out.
 *
 * All mutations invalidate the sources list query on settle.
 *
 * `remove` also optimistically drops the slot from the cached list so
 * the tile disappears instantly instead of waiting for the next poll.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the actions hook behind
 *   the "add camera" / "remove camera" buttons and the "start all" /
 *   "pause all" toolbar above the video grid.
 * Backend: POST /api/live/sources, DELETE /api/live/sources/{id},
 *   POST /api/live/sources/{id}/start|pause.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { LiveSourcesResponse } from "../../../shared/types/common";

import { adminApi, adminQueryKeys } from "../api";

export interface AddSourceInput {
  url: string;
  name?: string;
}

export interface AddResult {
  ok: boolean;
  error?: string;
}

export interface UseStreamRegistryResult {
  add: (input: AddSourceInput) => Promise<AddResult>;
  remove: (id: string) => Promise<void>;
  /** Bulk start/pause. Fans out one POST per id but invalidates the
   *  sources list exactly once on settle, so the post-action GET chain
   *  is N POST + 1 GET. */
  bulkSetRunning: (action: "start" | "pause", ids: string[]) => void;
  removingById: Record<string, boolean>;
  /** True while a bulk start/pause fan-out is in flight. */
  bulkBusy: boolean;
}

interface RemoveCtx {
  previous: LiveSourcesResponse | undefined;
}

export function useStreamRegistry(): UseStreamRegistryResult {
  const qc = useQueryClient();
  const [removingById, setRemovingById] = useState<Record<string, boolean>>({});

  const invalidateList = () => {
    void qc.invalidateQueries({ queryKey: adminQueryKeys.liveSources });
  };

  const addMutation = useMutation<AddResult, Error, AddSourceInput>({
    mutationFn: async (input) => {
      const res = await adminApi.addLiveSource({ ...input, autostart: true });
      return { ok: !!res.ok, error: res.error };
    },
    onSettled: invalidateList,
  });

  const removeMutation = useMutation<unknown, Error, string, RemoveCtx>({
    mutationFn: (id) => adminApi.removeLiveSource(id),
    onMutate: (id) => {
      setRemovingById((prev) => ({ ...prev, [id]: true }));
      const previous = qc.getQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources);
      qc.setQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources, (prev) =>
        prev ? { ...prev, sources: prev.sources.filter((s) => s.id !== id) } : prev,
      );
      return { previous };
    },
    onError: (_exc, _id, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(adminQueryKeys.liveSources, ctx.previous);
      }
    },
    onSettled: (_data, _err, id) => {
      setRemovingById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      invalidateList();
    },
  });

  const bulkMutation = useMutation<void, Error, { action: "start" | "pause"; ids: string[] }>({
    mutationFn: async ({ action, ids }) => {
      const fn = action === "start" ? adminApi.startLiveSource : adminApi.pauseLiveSource;
      // Parallel fan-out; `allSettled` so one failure doesn't abort the
      // rest. The post-settle invalidation shows which slots flipped.
      await Promise.allSettled(ids.map((id) => fn(id)));
    },
    onMutate: ({ action, ids }) => {
      const running = action === "start";
      qc.setQueryData<LiveSourcesResponse>(adminQueryKeys.liveSources, (prev) =>
        prev
          ? {
              ...prev,
              sources: prev.sources.map((s) => (ids.includes(s.id) ? { ...s, running } : s)),
            }
          : prev,
      );
    },
    onSettled: invalidateList,
  });

  const add = async (input: AddSourceInput): Promise<AddResult> => {
    try {
      return await addMutation.mutateAsync(input);
    } catch (exc) {
      return { ok: false, error: (exc as Error).message };
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await removeMutation.mutateAsync(id);
    } catch {
      // Errors already rolled back in onError; swallow so the caller's
      // await doesn't explode the tile-click handler.
    }
  };

  const bulkSetRunning = (action: "start" | "pause", ids: string[]) => {
    if (ids.length === 0) return;
    bulkMutation.mutate({ action, ids });
  };

  return {
    add,
    remove,
    bulkSetRunning,
    removingById,
    bulkBusy: bulkMutation.isPending,
  };
}
