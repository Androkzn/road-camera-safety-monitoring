/**
 * useLiveStatus.ts — custom hook that polls the live pipeline status.
 *
 * What it does:
 *   Calls /api/live/status every 5 seconds (default) and returns the latest
 *   LiveStatus object, any error, and a manual refetch().
 *
 * Purpose:
 *   A concise wrapper so pages can just read `data.source`, `data.started_at`,
 *   `data.perception`, etc. without writing fetch + timer boilerplate.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use` that
 *     bundles React state + effects.
 *   - Delegates to usePolling() (see usePolling.ts) for the timer + cleanup
 *     + state-holding; passes in api.getLiveStatus as the fetcher.
 *   - `intervalMs = 5000` is a default parameter — callers may override it.
 *
 * Connects to:
 *   - Backend: GET /api/live/status (defined in road_safety/server.py),
 *     returning the LiveStatus shape from types.ts (source, running,
 *     counters, started_at, perception).
 *   - UI: used by frontend/src/pages/DashboardPage.tsx (for source name,
 *     uptime, merged perception) and frontend/src/pages/MonitoringPage.tsx
 *     (for the source name in the top bar).
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

// useLiveStatus — polls GET /api/live/status every 5s; returns { data, error, refetch }.
// Consumed by: frontend/src/pages/DashboardPage.tsx (source, uptime, perception) and
// frontend/src/pages/MonitoringPage.tsx (source name in the top bar).
export function useLiveStatus(intervalMs = 5000) {
  // Thin wrapper around usePolling (see usePolling.ts); default 5s interval can be overridden by the caller.
  return usePolling({
    fetcher: api.getLiveStatus,
    intervalMs,
  });
}
