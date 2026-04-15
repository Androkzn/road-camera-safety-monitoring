import { usePolling } from "./usePolling";
import { api } from "../lib/api";
import type { WatchdogStatus, WatchdogFinding } from "../types";

export function useWatchdog() {
  const { data: status, refetch: refreshStatus } = usePolling<WatchdogStatus>({
    fetcher: api.getWatchdogStatus,
    intervalMs: 15_000,
  });

  const { data: findings, refetch: refreshFindings } = usePolling<WatchdogFinding[]>({
    fetcher: () => api.getWatchdogRecent(100),
    intervalMs: 30_000,
  });

  const refresh = () => {
    refreshStatus();
    refreshFindings();
  };

  const deleteFindings = async (keys: string[]) => {
    await api.deleteWatchdogFindings(keys);
    refresh();
  };

  const clearAll = async () => {
    await api.clearWatchdogFindings();
    refresh();
  };

  return { status, findings, refresh, deleteFindings, clearAll };
}
