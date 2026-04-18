/**
 * useDrift — polls `/api/drift` every `intervalMs` (default 30s) for the
 * model-drift report (detection-rate delta vs baseline etc.) shown on the
 * dashboard.
 *
 * TEACH: Yet another thin named wrapper around usePolling. 30s is a much
 * longer interval than useLiveStatus's 5s because drift is a slow-moving
 * signal — polling it aggressively would just waste battery on the edge
 * device. Always think about how quickly the underlying data can actually
 * change when picking an interval.
 *
 * Return shape: usePolling's { data, error, refetch }.
 *
 * Consumers:
 *   - pages/DashboardPage.tsx
 *     (`const { data: drift, refetch: refreshDrift } = useDrift();` — the
 *      page exposes a manual "refresh" button wired to `refreshDrift`.)
 *
 * See hooks/usePolling.ts for the React primitives taught on first use.
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useDrift(intervalMs = 30000) {
  return usePolling({
    fetcher: api.getDrift, // lib/api.ts
    intervalMs,
  });
}
