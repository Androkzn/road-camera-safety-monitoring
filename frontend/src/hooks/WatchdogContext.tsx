import { createContext, useContext, useCallback, type ReactNode } from "react";
import { usePolling } from "./usePolling";
import { api } from "../lib/api";
import type { WatchdogStatus, WatchdogFinding } from "../types";

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

async function fetchBoth(): Promise<WatchdogData> {
  const [status, findings] = await Promise.all([
    api.getWatchdogStatus(),
    api.getWatchdogRecent(100),
  ]);
  return { status, findings };
}

export function WatchdogProvider({ children }: { children: ReactNode }) {
  const { data, refetch } = usePolling<WatchdogData>({
    fetcher: fetchBoth,
    intervalMs: 15_000,
  });

  const refresh = useCallback(() => { refetch(); }, [refetch]);

  const deleteFindings = useCallback(async (keys: string[]) => {
    await api.deleteWatchdogFindings(keys);
    refetch();
  }, [refetch]);

  const clearAll = useCallback(async () => {
    await api.clearWatchdogFindings();
    refetch();
  }, [refetch]);

  return (
    <Ctx.Provider
      value={{
        status: data?.status ?? null,
        findings: data?.findings ?? null,
        refresh,
        deleteFindings,
        clearAll,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useWatchdogCtx() {
  return useContext(Ctx);
}
