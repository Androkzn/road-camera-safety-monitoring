import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useLiveStatus(intervalMs = 5000) {
  return usePolling({
    fetcher: api.getLiveStatus,
    intervalMs,
  });
}
