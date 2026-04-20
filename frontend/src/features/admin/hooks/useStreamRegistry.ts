/**
 * useStreamRegistry — registry-wide mutations that don't target a single
 * slot: `add`, `remove`, `restartAll`.
 *
 * All three are `useMutation`s that invalidate the sources list query on
 * settle. In particular `restartAll` does **one** `invalidateQueries`
 * call on settle, not N — even though the per-source POSTs it fans out
 * still happen one request per slot on the wire (the backend exposes
 * `/restart_all` as one call so that's what we invoke; but the analogous
 * "start all" / "pause all" toolbar actions iterate on the client until
 * BE-D16 lands a bulk endpoint — see the toolbar in `MultiSourceGrid`).
 *
 * `remove` also optimistically drops the slot from the cached list so
 * the tile disappears instantly instead of waiting for the next poll.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { dialog } from "../../../shared/ui";
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
  restartAll: () => Promise<void>;
  /** Bulk start/pause. Fans out one POST per id (no server-side bulk
   *  endpoint yet — BE-D16) but invalidates the sources list exactly
   *  once on settle, so the post-action GET chain is N POST + 1 GET. */
  bulkSetRunning: (action: "start" | "pause", ids: string[]) => void;
  removingById: Record<string, boolean>;
  /** True while `/restart_all` is in flight. */
  restartingAll: boolean;
  /** True while a bulk start/pause fan-out is in flight. */
  bulkBusy: boolean;
  /** Increments on every successful `restartAll`. Consumers (e.g. a future
   *  map hook) can watch this to reset client-side playheads. */
  restartAllToken: number;
}

interface RemoveCtx {
  previous: LiveSourcesResponse | undefined;
}

export function useStreamRegistry(): UseStreamRegistryResult {
  const qc = useQueryClient();
  const [removingById, setRemovingById] = useState<Record<string, boolean>>({});
  const [restartAllToken, setRestartAllToken] = useState(0);

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

  const restartAllMutation = useMutation<
    Awaited<ReturnType<typeof adminApi.restartAllLiveSources>>,
    Error,
    void
  >({
    mutationFn: () => adminApi.restartAllLiveSources(),
    onSuccess: (res) => {
      // Bump the token only on a fully-successful restart so downstream
      // consumers don't snap back on a partial failure.
      if (res.ok) {
        setRestartAllToken((n) => n + 1);
      }
      const failed = (res.results ?? []).filter((r) => !r.ok);
      if (failed.length) {
        void dialog.alert({
          title: "Some streams failed to restart",
          message: failed.map((f) => `${f.name || f.id}: ${f.error ?? "unknown error"}`).join("\n"),
          variant: "danger",
        });
      }
    },
    onError: (exc) => {
      void dialog.alert({
        title: "Restart all failed",
        message: exc?.message ?? "unknown error",
        variant: "danger",
      });
    },
    // D2.D: invalidate the sources list exactly once on settle instead of
    // one refresh per per-source POST. Network-wise: N POST + 1 GET, not
    // N POST + N GETs. (Bulk start/pause toolbar actions still iterate
    // per-source on the client; drops to a single GET once they land on
    // a dedicated bulk endpoint — tracked in BE-D16.)
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

  const restartAll = async (): Promise<void> => {
    try {
      await restartAllMutation.mutateAsync();
    } catch {
      // dialog already surfaced in onError.
    }
  };

  const bulkSetRunning = (action: "start" | "pause", ids: string[]) => {
    if (ids.length === 0) return;
    bulkMutation.mutate({ action, ids });
  };

  return {
    add,
    remove,
    restartAll,
    bulkSetRunning,
    removingById,
    restartingAll: restartAllMutation.isPending,
    bulkBusy: bulkMutation.isPending,
    restartAllToken,
  };
}
