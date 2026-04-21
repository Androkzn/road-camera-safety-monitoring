/**
 * useImpact — polls `/api/settings/impact` for the active session.
 *
 * Wraps the impact-preview endpoint in a TanStack Query so the Settings
 * console can show predicted-volume / severity / ops-delta numbers that
 * update in the background without manual polling wiring. Polling is
 * paused in background tabs (`refetchIntervalInBackground: false`) to
 * avoid burning quota while nobody is looking.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: Feeds the impact card on the right column (predicted change
 *   in alert volume, severity bars, ops deltas).
 * Backend: GET /api/settings/impact.
 * Consumers: `SettingsPage` and `useSettingsApply` (which triggers a manual
 *   `refresh()` after a successful apply to re-baseline the preview).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";

import { settingsApi, settingsQueryKeys } from "../api";
import type { ImpactReport } from "../types";

/**
 * Public return shape of {@link useImpact}.
 *
 * - `report`         — last successfully fetched `ImpactReport`, or `null`
 *   while the first load is in flight / after a hard failure.
 * - `refreshing`     — true whenever a fetch (initial or refetch) is in flight.
 * - `error`          — flattened string error from the most recent query
 *   failure; cleared on the next success.
 * - `lastUpdatedTs`  — `Date.now()`-style timestamp of the last successful
 *   response (used by the UI to show "updated N seconds ago").
 * - `refresh`        — force a manual refetch and resolve when it settles.
 */
export interface ImpactState {
  report: ImpactReport | null;
  refreshing: boolean;
  error: string | null;
  lastUpdatedTs: number | null;
  refresh: () => Promise<void>;
}

/**
 * Fetch + poll the impact-preview payload for the Settings page.
 *
 * No params. Returns an {@link ImpactState}.
 *
 * Caching / loading / error semantics:
 * - Cache key: `settingsQueryKeys.impact` (shared across the app so that
 *   `useSettingsApply` can invalidate it post-apply).
 * - Polls every `POLL_INTERVAL_MS.settingsImpact` while the tab is focused;
 *   pauses in background tabs; refetches on window focus.
 * - `refreshing` is `query.isFetching` so it also reflects background polls,
 *   not just the initial load.
 * - `error` is a flattened string (Error message or `null`), so the UI never
 *   needs to deal with the raw query error object.
 * - `lastUpdatedTs` is tracked independently of the query cache so it only
 *   advances on a genuine success — errors don't reset the timestamp.
 */
export function useImpact(): ImpactState {
  const query = useQuery({
    queryKey: settingsQueryKeys.impact,
    queryFn: ({ signal }) => settingsApi.getImpact({ signal }),
    refetchInterval: POLL_INTERVAL_MS.settingsImpact,
    // Stop polling while the tab is hidden — impact is UI-only, not alerting.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  // Separate "last successful fetch" clock so errors don't reset the "N seconds
  // ago" badge the page shows next to the impact card.
  const [lastUpdatedTs, setLastUpdatedTs] = useState<number | null>(null);
  useEffect(() => {
    if (query.isSuccess && query.dataUpdatedAt) {
      setLastUpdatedTs(query.dataUpdatedAt);
    }
  }, [query.isSuccess, query.dataUpdatedAt]);

  // Flatten the TanStack error into a string the banner can render directly.
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
