/**
 * useDrift.ts — custom hook that polls the model drift report endpoint.
 *
 * What it does:
 *   Calls /api/drift every 30 seconds (default) and returns the latest
 *   DriftReport (precision/trend/alert over a rolling window), any error,
 *   and a manual refetch().
 *
 * Purpose:
 *   Powers the DriftBannerRow on the dashboard, which warns the operator
 *   when precision is dropping or an alert has fired.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use`.
 *   - Delegates to usePolling() (see usePolling.ts) for the timer + state;
 *     passes api.getDrift as the fetcher.
 *   - Default parameter `intervalMs = 30000` — callers may pass a
 *     different interval to override.
 *
 * Connects to:
 *   - Backend: GET /api/drift (defined in road_safety/server.py),
 *     returning the DriftReport shape from types.ts (window_size, TP/FP,
 *     precision, trend, alert flag).
 *   - UI: used by frontend/src/pages/DashboardPage.tsx, feeding
 *     frontend/src/components/dashboard/DriftBannerRow.tsx; the dashboard
 *     also passes its refetch() as an onRefresh prop so the banner can
 *     offer a manual "refresh" button.
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

// useDrift — polls GET /api/drift every 30s; returns { data, error, refetch }.
// Consumed by: frontend/src/pages/DashboardPage.tsx, feeding frontend/src/components/dashboard/DriftBannerRow.tsx
// (refetch is passed as onRefresh so the banner gets a manual refresh button).
export function useDrift(intervalMs = 30000) {
  // Thin wrapper around usePolling (see usePolling.ts); 30s is slow because drift only changes over many events.
  return usePolling({
    fetcher: api.getDrift,
    intervalMs,
  });
}
