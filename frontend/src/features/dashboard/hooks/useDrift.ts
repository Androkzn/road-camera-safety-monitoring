/**
 * useDrift — TanStack Query for the drift report. Long interval (from
 * POLL_INTERVAL_MS.dashboardDrift, ~30s) because labelled-feedback drift
 * is a slow signal — polling aggressively would just waste battery on
 * the edge.
 *
 * Queries/mutations: a single `useQuery` keyed by `dashboardQueryKeys.drift`.
 *   Cache is shared across all consumers — if two components call
 *   useDrift() simultaneously they dedupe to one HTTP request.
 *
 * Returns the standard `{ data, isLoading, error, refetch, ... }` shape;
 * components call `refetch()` on demand (e.g. DriftBannerRow onClick).
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — feeds the drift banner (third of the three
 *   thin status banners under the KPI tiles); clicking that banner calls
 *   refetch() exposed by this hook.
 * Consumer: DashboardPage destructures `{ data: drift, refetch: refreshDrift }`
 *   and passes them to the drift banner row.
 * Backend: GET /api/drift — returns DriftReport (distribution-shift monitor
 *   stats computed from labelled feedback vs. current predictions).
 */
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { dashboardApi, dashboardQueryKeys } from "../api";

/**
 * Poll `/api/drift`. Override the cadence via `refetchIntervalMs` —
 * useful when the banner is off-screen and we want to back off.
 *
 * Params:
 *   - `refetchIntervalMs` (optional): polling cadence in ms. Defaults to
 *     POLL_INTERVAL_MS.dashboardDrift (~30s).
 *
 * Returns: TanStack Query result:
 *   - `data`: DriftReport | undefined — populated on first success.
 *   - `isLoading`: true only on the initial fetch (no cached data yet).
 *   - `isFetching`: true during any fetch including background refetches.
 *   - `error`: populated on failure; query stays mounted and retries per
 *     the default TanStack Query policy.
 *   - `refetch`: manual re-fetch trigger (used by the banner click handler).
 *
 * Cache/staleness: default `staleTime` of 0 (immediate stale on success),
 *   so any new mount will kick off a fetch while serving the cached
 *   payload; `refetchInterval` drives periodic refresh. The query's
 *   AbortSignal is threaded to fetch so unmounting cancels in-flight
 *   requests.
 */
export function useDrift(refetchIntervalMs: number = POLL_INTERVAL_MS.dashboardDrift) {
  return useQuery({
    queryKey: dashboardQueryKeys.drift,
    queryFn: ({ signal }) => dashboardApi.getDrift(signal),
    refetchInterval: refetchIntervalMs,
  });
}
