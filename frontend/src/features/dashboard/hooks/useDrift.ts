/**
 * useDrift — TanStack Query for the drift report. Long interval (30s)
 * because labelled-feedback drift is a slow signal — polling aggressively
 * would just waste battery on the edge.
 */
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { dashboardApi, dashboardQueryKeys } from "../api";

export function useDrift(
  refetchIntervalMs: number = POLL_INTERVAL_MS.dashboardDrift,
) {
  return useQuery({
    queryKey: dashboardQueryKeys.drift,
    queryFn: ({ signal }) => dashboardApi.getDrift(signal),
    refetchInterval: refetchIntervalMs,
  });
}
