/**
 * useImpact — polls `/api/settings/impact` for the active session.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

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

export function useImpact(): ImpactState {
  const query = useQuery({
    queryKey: settingsQueryKeys.impact,
    queryFn: ({ signal }) => settingsApi.getImpact({ signal }),
    refetchInterval: POLL_INTERVAL_MS.settingsImpact,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const [lastUpdatedTs, setLastUpdatedTs] = useState<number | null>(null);
  useEffect(() => {
    if (query.isSuccess && query.dataUpdatedAt) {
      setLastUpdatedTs(query.dataUpdatedAt);
    }
  }, [query.isSuccess, query.dataUpdatedAt]);

  const error = useMemo<string | null>(() => {
    const exc = query.error;
    if (!exc) return null;
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
