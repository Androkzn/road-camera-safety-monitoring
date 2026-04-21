/**
 * useAdminHealth.ts — custom hook that polls the server health endpoint.
 *
 * What it does:
 *   Calls /api/admin/health every 4 seconds (or the interval passed in) and
 *   returns the latest HealthData object, any error, and a manual refetch.
 *
 * Purpose:
 *   A tiny convenience wrapper so the admin page can just read `data` and
 *   not worry about timers, cleanup, or fetch boilerplate.
 *
 * How it works:
 *   - This is a "custom hook": a function starting with `use` that wraps
 *     React state so callers re-render when the data changes.
 *   - It delegates everything to usePolling(), a generic helper that sets
 *     up a setInterval loop and cleans it up on unmount. See usePolling.ts.
 *   - `intervalMs = 4000` uses a default parameter — the caller may pass a
 *     different number to override it.
 *
 * Connects to:
 *   - Backend: GET /api/admin/health (defined in road_safety/server.py),
 *     returning the HealthData shape from types.ts (server info, pipeline
 *     counters, perception state, scene, integrations).
 *   - UI: used by frontend/src/pages/AdminPage.tsx; the returned `data`
 *     drives <HealthStrip/> and the uptime pill in the top bar.
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

// useAdminHealth — polls GET /api/admin/health every 4s; returns { data, error, refetch }.
// Consumed by: frontend/src/pages/AdminPage.tsx — `data` drives <HealthStrip/> and the uptime pill.
export function useAdminHealth(intervalMs = 4000) {
  // Thin wrapper: usePolling (see usePolling.ts) owns the setInterval loop and exposes the polled state.
  return usePolling({
    fetcher: api.getAdminHealth,
    intervalMs,
  });
}
