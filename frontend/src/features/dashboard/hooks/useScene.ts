/**
 * useScene — TanStack Query for the scene-classifier output.
 *
 * Scene context drifts slowly (urban → highway transitions take seconds),
 * so a 7s refetch is plenty. The cache is shared by every consumer —
 * multiple components calling `useScene()` issue only one HTTP request.
 *
 * Queries/mutations: a single `useQuery` keyed by `dashboardQueryKeys.scene`.
 *   Read-only hook; no mutation counterpart. The same cache entry is
 *   reused by any other component that mounts this hook.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — feeds the Scene banner (middle of the three
 *   thin status banners under the KPI tiles), showing urban/highway/parking
 *   classification and a few derived metrics.
 * Consumer: DashboardPage destructures `{ data: scene }` and hands it to
 *   the scene banner row.
 * Backend: GET /api/live/scene — scene context classifier output
 *   (urban/highway/parking) from backend/core/context.py. Drives
 *   AdaptiveThresholds re-scaling on the server side; the dashboard just
 *   surfaces the current label for operator awareness.
 */
// TEACH: `useQuery` = read hook. `useMutation` = write hook. Both live
// in TanStack Query and share the same underlying cache.
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { dashboardApi, dashboardQueryKeys } from "../api";

/**
 * Poll `/api/live/scene` every `refetchIntervalMs` (default ~7 s).
 * Returns `{ data, isLoading, error, ... }` from TanStack Query.
 *
 * Params:
 *   - `refetchIntervalMs` (optional): polling cadence in ms. Defaults to
 *     POLL_INTERVAL_MS.dashboardScene (~7s). Tune down for demo mode,
 *     up for battery-sensitive deployments.
 *
 * Returns: TanStack Query result:
 *   - `data`: SceneContext | undefined — scene label + derived metrics.
 *   - `isLoading`: true only while the first request is in flight.
 *   - `isFetching`: true during background refetches as well.
 *   - `error`: set on failure; the banner should degrade gracefully.
 *   - `refetch`: manual re-fetch (not currently wired by DashboardPage).
 *
 * Cache/staleness: `staleTime` defaults to 0, so any remount immediately
 *   refetches while showing the cached label; `refetchInterval` handles
 *   periodic refresh. The AbortSignal from TanStack Query is plumbed
 *   through to fetchJson, so unmount cancels the in-flight request.
 *   Error + retry behaviour is the default TanStack policy (3 retries,
 *   exponential backoff).
 */
export function useScene(refetchIntervalMs: number = POLL_INTERVAL_MS.dashboardScene) {
  return useQuery({
    queryKey: dashboardQueryKeys.scene,
    queryFn: ({ signal }) => dashboardApi.getScene(signal),
    refetchInterval: refetchIntervalMs,
  });
}
