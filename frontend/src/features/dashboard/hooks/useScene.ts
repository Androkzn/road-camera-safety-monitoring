/**
 * useScene — TanStack Query for the scene-classifier output.
 *
 * Scene context drifts slowly (urban → highway transitions take seconds),
 * so a 7s refetch is plenty. The cache is shared by every consumer —
 * multiple components calling `useScene()` issue only one HTTP request.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — feeds the Scene banner (middle of the three
 *   thin status banners under the KPI tiles), showing urban/highway/parking
 *   classification and a few derived metrics.
 * Backend: GET /api/live/scene
 */
// TEACH: `useQuery` = read hook. `useMutation` = write hook. Both live
// in TanStack Query and share the same underlying cache.
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { dashboardApi, dashboardQueryKeys } from "../api";

/**
 * Poll `/api/live/scene` every `refetchIntervalMs` (default ~7 s).
 * Returns `{ data, isLoading, error, ... }` from TanStack Query.
 */
export function useScene(refetchIntervalMs: number = POLL_INTERVAL_MS.dashboardScene) {
  return useQuery({
    queryKey: dashboardQueryKeys.scene,
    queryFn: ({ signal }) => dashboardApi.getScene(signal),
    refetchInterval: refetchIntervalMs,
  });
}
