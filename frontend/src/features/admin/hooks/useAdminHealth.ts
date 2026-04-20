/**
 * useAdminHealth — TanStack Query for `/api/admin/health`.
 */
import { useQuery } from "@tanstack/react-query";

import { adminApi, adminQueryKeys } from "../api";

export function useAdminHealth(refetchIntervalMs = 4000) {
  return useQuery({
    queryKey: adminQueryKeys.health,
    queryFn: ({ signal }) => adminApi.getHealth(signal),
    refetchInterval: refetchIntervalMs,
  });
}
