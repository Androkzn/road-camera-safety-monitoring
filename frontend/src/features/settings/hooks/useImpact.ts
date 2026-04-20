/**
 * useImpact — polls `/api/settings/impact` for the active session.
 *
 * Routed through TanStack Query (D2.B) so the cache + dedup match the
 * rest of the settings feature, and so a backgrounded Settings tab
 * stops issuing `/api/settings/impact` requests
 * (`refetchIntervalInBackground: false`). The pre-D2.B version used a
 * hand-rolled `setInterval` that fired on backgrounded tabs and needed
 * an `eslint-disable react-hooks/exhaustive-deps` to keep its closure
 * over `refresh` quiet.
 *
 * Admin-auth failures (`MissingAdminTokenError` / `isAdminAuthFailure`)
 * skip retry and clear the cached token so the SettingsPage flips to
 * the token prompt instead of silently retrying. Mirrors the error
 * classification in `useSettings`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  clearAdminToken,
  isAdminAuthFailure,
  MissingAdminTokenError,
} from "../../../shared/lib/adminApi";
import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";

import { settingsApi, settingsQueryKeys } from "../api";
import type { ImpactReport } from "../types";

export interface ImpactState {
  report: ImpactReport | null;
  refreshing: boolean;
  error: string | null;
  lastUpdatedTs: number | null;
  refresh: () => Promise<void>;
}

export function useImpact(token: string | null): ImpactState {
  const query = useQuery({
    queryKey: settingsQueryKeys.impact,
    queryFn: ({ signal }) => settingsApi.getImpact({ signal }),
    enabled: !!token,
    refetchInterval: POLL_INTERVAL_MS.settingsImpact,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: (_count, err) => !(err instanceof MissingAdminTokenError) && !isAdminAuthFailure(err),
  });

  // Drop the cached admin token on auth failure so SettingsPage flips
  // to the token prompt instead of silently retrying.
  useEffect(() => {
    if (query.error && isAdminAuthFailure(query.error)) {
      clearAdminToken();
    }
  }, [query.error]);

  // Track wall-clock of the last successful fetch — `dataUpdatedAt`
  // from React Query also covers cached hits on mount, so derive our
  // own timestamp from successful settles only.
  const [lastUpdatedTs, setLastUpdatedTs] = useState<number | null>(null);
  useEffect(() => {
    if (query.isSuccess && query.dataUpdatedAt) {
      setLastUpdatedTs(query.dataUpdatedAt);
    }
  }, [query.isSuccess, query.dataUpdatedAt]);

  const error = useMemo<string | null>(() => {
    const exc = query.error;
    if (!exc) return null;
    if (exc instanceof MissingAdminTokenError) return null;
    if (exc instanceof Error) return exc.message;
    return null;
  }, [query.error]);

  const refresh = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    report: query.data?.report ?? null,
    refreshing: query.isFetching,
    error,
    lastUpdatedTs,
    refresh,
  };
}
