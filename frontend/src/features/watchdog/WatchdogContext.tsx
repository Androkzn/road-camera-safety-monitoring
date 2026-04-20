/**
 * WatchdogContext — shared TanStack Query for status + findings.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LIMITS, POLL_INTERVAL_MS, STALE_TIME_MS } from "../../shared/config/runtime";
import { dialog } from "../../shared/ui";
import type { WatchdogFinding, WatchdogStatus } from "../../shared/types/common";

import { watchdogApi, watchdogQueryKeys } from "./api";

interface WatchdogData {
  status: WatchdogStatus;
  findings: WatchdogFinding[];
}

interface WatchdogCtx {
  status: WatchdogStatus | null;
  findings: WatchdogFinding[] | null;
  refresh: () => void;
  deleteFindings: (keys: string[]) => Promise<void>;
  clearAll: () => Promise<void>;
}

const Ctx = createContext<WatchdogCtx>({
  status: null,
  findings: null,
  refresh: () => {},
  deleteFindings: async () => {},
  clearAll: async () => {},
});

async function fetchBoth(signal?: AbortSignal): Promise<WatchdogData> {
  const [status, findings] = await Promise.all([
    watchdogApi.getStatus(signal),
    watchdogApi.getRecent(LIMITS.watchdogRecent, signal),
  ]);
  return { status, findings };
}

function handleWatchdogError(exc: unknown, action: string): void {
  console.error(exc);
  void dialog.alert({
    title: `${action} failed`,
    message: (exc as Error)?.message ?? "unknown error",
    variant: "danger",
  });
}

export function WatchdogProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: watchdogQueryKeys.combined,
    queryFn: ({ signal }) => fetchBoth(signal),
    refetchInterval: POLL_INTERVAL_MS.watchdog,
    staleTime: STALE_TIME_MS.watchdog,
  });

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const deleteMutation = useMutation({
    mutationFn: (keys: string[]) => watchdogApi.deleteFindings(keys),
    onSuccess: () => qc.invalidateQueries({ queryKey: watchdogQueryKeys.combined }),
  });

  const clearMutation = useMutation({
    mutationFn: () => watchdogApi.clearAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: watchdogQueryKeys.combined }),
  });

  const deleteFindings = useCallback(
    async (keys: string[]) => {
      try {
        await deleteMutation.mutateAsync(keys);
      } catch (exc) {
        handleWatchdogError(exc, "Delete findings");
      }
    },
    [deleteMutation],
  );

  const clearAll = useCallback(async () => {
    try {
      await clearMutation.mutateAsync();
    } catch (exc) {
      handleWatchdogError(exc, "Clear all findings");
    }
  }, [clearMutation]);

  const value = useMemo<WatchdogCtx>(
    () => ({
      status: data?.status ?? null,
      findings: data?.findings ?? null,
      refresh,
      deleteFindings,
      clearAll,
    }),
    [data?.status, data?.findings, refresh, deleteFindings, clearAll],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWatchdogCtx() {
  return useContext(Ctx);
}
