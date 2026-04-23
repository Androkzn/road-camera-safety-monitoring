/**
 * useLiveSourcesList — thin TanStack Query wrapper around
 * `GET /api/live/sources`.
 *
 * Returns just the list, the primary id, loading/error flags, and a
 * `refresh()` that triggers a refetch. Per-source mutations live in
 * `useStreamControl`; registry-level mutations live in `useStreamRegistry`.
 *
 * Default poll cadence is 5 s (matches AdminPage). SettingsPage mounts
 * this with 15 s because it only renders the list as a sidebar preview.
 *
 * Why the custom hook? Projects consumer-facing shape (list, primary,
 * loading, error, refresh) so components don't have to know about
 * TanStack Query's richer `{ data, isLoading, error, refetch }` API.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the polling data hook
 *   that supplies the list of cameras shown in the video-tile grid (also
 *   reused as a sidebar preview on the Settings page).
 * Backend: GET /api/live/sources (polled every ~5 s).
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS, STALE_TIME_MS } from "../../../shared/config/runtime";
import type { LiveSourceStatus, LiveSourcesResponse } from "../../../shared/types/common";

import { adminApi, adminQueryKeys } from "../api";

/** Shape the hook exposes to consumers. Exported so `useLiveSources`
 *  (the aggregator) can re-project it. */
export interface UseLiveSourcesListResult {
  sources: LiveSourceStatus[];
  primaryId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Subscribe to the live-sources registry. Polls every `refetchIntervalMs`.
 *
 * @param refetchIntervalMs override the poll cadence for secondary
 *   mount points (e.g. SettingsPage uses a slower cadence).
 */
export function useLiveSourcesList(
  refetchIntervalMs: number = POLL_INTERVAL_MS.liveSources,
): UseLiveSourcesListResult {
  // TEACH: `useQuery<T>(...)` typed so `data` is `T | undefined`. The
  // `staleTime` tells React Query "treat cached data as fresh for this
  // long" — dedupes re-fetches when several components mount at once.
  const { data, error, refetch, isLoading } = useQuery<LiveSourcesResponse>({
    queryKey: adminQueryKeys.liveSources,
    queryFn: ({ signal }) => adminApi.getLiveSources(signal),
    refetchInterval: refetchIntervalMs,
    staleTime: STALE_TIME_MS.liveSources,
  });

  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    // `?.` optional chain + `??` default — safe field access when
    // `data` might be `undefined` during the initial fetch.
    sources: data?.sources ?? [],
    primaryId: data?.primary_id ?? null,
    loading: isLoading,
    error: error ? (error as Error).message : null,
    refresh,
  };
}
