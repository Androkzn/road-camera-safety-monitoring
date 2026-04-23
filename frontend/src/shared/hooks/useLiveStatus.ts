/**
 * useLiveStatus — TanStack Query wrapper for `/api/live/status`.
 *
 * Endpoint: GET /api/live/status → LiveStatus (pydantic-generated type).
 * Downstream consumers: TopBar live-status pill, DashboardPage header,
 * MonitoringPage, SettingsPage — anywhere the app needs to answer
 * "is the perception loop alive?" and "which source is active?".
 *
 * Used by Dashboard / Monitoring / Settings — the source-of-truth for
 * "is the perception loop alive" and the source name that the TopBar
 * displays. With React Query this query is automatically deduped across
 * pages and refetched on window focus.
 *
 * --- UI mapping ---
 * Used on: DashboardPage, MonitoringPage, SettingsPage (and indirectly
 *   AdminPage via the TopBar live-status pill).
 * UI element: no element on its own — feeds the green/red live-status
 *   dot and source label rendered by the TopBar on every page.
 */
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../config/runtime";
import { fetchJson } from "../lib/fetchClient";
import type { LiveStatus } from "../types/common";

// Shared cache key — exported so other modules can invalidate or read the
// cached value (e.g. after a settings mutation that changes the active source).
// Tuple form + `as const` gives TanStack Query the strictest key typing.
export const liveStatusQueryKey = ["shared", "liveStatus"] as const;

/**
 * useLiveStatus — polls /api/live/status on an interval via React Query.
 *
 * Params:
 *   - refetchIntervalMs: polling cadence in ms. Defaults to
 *     POLL_INTERVAL_MS.liveStatus (5s) from shared/config/runtime.
 *
 * Returns: full TanStack Query result — { data: LiveStatus | undefined,
 *   isLoading, isError, error, refetch, ... }. All pages that call this
 *   hook share one deduped cache entry (single network request in flight).
 *
 * Side effects: starts an interval-based background refetch; cancels
 *   in-flight requests via the AbortSignal on unmount or refetch.
 */
export function useLiveStatus(refetchIntervalMs: number = POLL_INTERVAL_MS.liveStatus) {
  return useQuery({
    queryKey: liveStatusQueryKey,
    // `signal` is wired so unmount aborts the fetch (no orphan requests).
    queryFn: ({ signal }) => fetchJson<LiveStatus>("/api/live/status", { signal }),
    refetchInterval: refetchIntervalMs,
  });
}
