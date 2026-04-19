/**
 * useImpact — polls `/api/settings/impact` for the active session.
 *
 * SSE upgrade is reserved for a follow-up — the v1 polling path keeps the
 * UI dependency-free and gracefully tolerates network blips.
 */

import { useEffect, useRef, useState } from "react";

import { adminFetch, type AdminApiError, clearAdminToken } from "../lib/adminApi";
import type { ImpactReport } from "../types";

const POLL_MS = 5_000;

interface ImpactResponse {
  report: ImpactReport | null;
}

export function useImpact(token: string | null): {
  report: ImpactReport | null;
  refreshing: boolean;
  error: string | null;
  lastUpdatedTs: number | null;
  refresh: () => Promise<void>;
} {
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedTs, setLastUpdatedTs] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      const data = await adminFetch<ImpactResponse>("/api/settings/impact");
      if (!mountedRef.current) return;
      setReport(data.report);
      setLastUpdatedTs(Date.now());
      setError(null);
    } catch (exc) {
      const status = (exc as AdminApiError | undefined)?.status;
      if (status === 401 || status === 403 || status === 503) {
        // Stop polling on auth failure; the SettingsPage will re-prompt
        // for a token via useSettings.
        clearAdminToken();
      }
      if (exc instanceof Error) setError(exc.message);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return { report, refreshing, error, lastUpdatedTs, refresh };
}
