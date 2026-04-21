/**
 * useDrift — TanStack Query for the drift report. Long interval (30s)
 * because labelled-feedback drift is a slow signal — polling aggressively
 * would just waste battery on the edge.
 *
 * Returns the standard `{ data, isLoading, error, refetch, ... }` shape;
 * components call `refetch()` on demand (e.g. DriftBannerRow onClick).
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — feeds the drift banner (third of the three
 *   thin status banners under the KPI tiles); clicking that banner calls
 *   refetch() exposed by this hook.
 * Backend: GET /api/drift
 */
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { dashboardApi, dashboardQueryKeys } from "../api";

/**
 * Poll `/api/drift`. Override the cadence via `refetchIntervalMs` —
 * useful when the banner is off-screen and we want to back off.
 */
export function useDrift(refetchIntervalMs: number = POLL_INTERVAL_MS.dashboardDrift) {
  return useQuery({
    queryKey: dashboardQueryKeys.drift,
    queryFn: ({ signal }) => dashboardApi.getDrift(signal),
    refetchInterval: refetchIntervalMs,
  });
}
