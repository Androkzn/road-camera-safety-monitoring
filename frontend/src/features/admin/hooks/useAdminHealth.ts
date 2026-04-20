/**
 * useAdminHealth — TanStack Query for `/api/admin/health`.
 */
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { adminApi, adminQueryKeys } from "../api";

export function useAdminHealth(
  refetchIntervalMs: number = POLL_INTERVAL_MS.adminHealth,
) {
  return useQuery({
    queryKey: adminQueryKeys.health,
    queryFn: ({ signal }) => adminApi.getHealth(signal),
    refetchInterval: refetchIntervalMs,
  });
}
