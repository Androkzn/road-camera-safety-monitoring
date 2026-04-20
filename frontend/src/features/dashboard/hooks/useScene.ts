/**
 * useScene — TanStack Query for the scene-classifier output.
 *
 * Scene context drifts slowly (urban → highway transitions take seconds),
 * so a 7s refetch is plenty. The cache is shared by every consumer.
 */
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { dashboardApi, dashboardQueryKeys } from "../api";

export function useScene(refetchIntervalMs: number = POLL_INTERVAL_MS.dashboardScene) {
  return useQuery({
    queryKey: dashboardQueryKeys.scene,
    queryFn: ({ signal }) => dashboardApi.getScene(signal),
    refetchInterval: refetchIntervalMs,
  });
}
