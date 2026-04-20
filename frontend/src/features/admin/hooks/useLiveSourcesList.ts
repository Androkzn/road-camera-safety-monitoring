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
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS, STALE_TIME_MS } from "../../../shared/config/runtime";
import type { LiveSourceStatus, LiveSourcesResponse } from "../../../shared/types/common";

import { adminApi, adminQueryKeys } from "../api";

export interface UseLiveSourcesListResult {
  sources: LiveSourceStatus[];
  primaryId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useLiveSourcesList(
  refetchIntervalMs: number = POLL_INTERVAL_MS.liveSources,
): UseLiveSourcesListResult {
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
    sources: data?.sources ?? [],
    primaryId: data?.primary_id ?? null,
    loading: isLoading,
    error: error ? (error as Error).message : null,
    refresh,
  };
}
