import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useScene(intervalMs = 7000) {
  return usePolling({
    fetcher: api.getScene,
    intervalMs,
  });
}
