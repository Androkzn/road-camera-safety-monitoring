import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useDrift(intervalMs = 30000) {
  return usePolling({
    fetcher: api.getDrift,
    intervalMs,
  });
}
