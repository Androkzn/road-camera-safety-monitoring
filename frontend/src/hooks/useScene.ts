/**
 * useScene.ts — custom hook that polls the current scene-context endpoint.
 *
 * What it does:
 *   Calls /api/live/scene every 7 seconds (default) and returns the latest
 *   SceneContext (label, speed proxy, pedestrian rate, active thresholds,
 *   reason), any error, and a manual refetch().
 *
 * Purpose:
 *   Powers the SceneBannerRow on the dashboard, which shows what kind of
 *   scene the pipeline thinks it is looking at (urban, highway, etc.) and
 *   which safety thresholds are active.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use`.
 *   - Delegates to usePolling() for the timer + state handling; passes
 *     api.getScene as the fetcher.
 *   - Default parameter `intervalMs = 7000` — callers may override.
 *
 * Connects to:
 *   - Backend: GET /api/live/scene (defined in road_safety/server.py),
 *     returning the SceneContext shape from types.ts.
 *   - UI: used by frontend/src/pages/DashboardPage.tsx, feeding
 *     frontend/src/components/dashboard/SceneBannerRow.tsx.
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

// useScene — polls GET /api/live/scene every 7s; returns { data, error, refetch }.
// Consumed by: frontend/src/pages/DashboardPage.tsx, feeding frontend/src/components/dashboard/SceneBannerRow.tsx.
export function useScene(intervalMs = 7000) {
  // Thin wrapper around usePolling (see usePolling.ts); the fetcher hits the scene-context endpoint.
  return usePolling({
    fetcher: api.getScene,
    intervalMs,
  });
}
