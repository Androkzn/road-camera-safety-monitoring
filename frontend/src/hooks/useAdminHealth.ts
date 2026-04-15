import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useAdminHealth(intervalMs = 4000) {
  return usePolling({
    fetcher: api.getAdminHealth,
    intervalMs,
  });
}
