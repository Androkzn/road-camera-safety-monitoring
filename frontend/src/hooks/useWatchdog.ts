/**
 * useWatchdog.ts — standalone (non-context) hook that polls watchdog status
 * and recent findings and exposes delete/clear helpers.
 *
 * What it does:
 *   Polls /api/watchdog every 15s for the status summary and
 *   /api/watchdog/recent every 30s for the latest 100 findings. Returns
 *   both, plus `refresh` (re-fetch both), `deleteFindings(keys)`, and
 *   `clearAll()` helpers that call the mutating endpoints and then refetch.
 *
 * Purpose:
 *   A self-contained alternative to WatchdogContext for pages that want
 *   their own copy of watchdog data without depending on the app-wide
 *   provider. (The main pages use WatchdogContext instead; this hook is
 *   kept for stand-alone / testing use.)
 *
 * How it works:
 *   - Calls usePolling() twice — once for status, once for findings — each
 *     with its own interval. See usePolling.ts for the underlying mechanics.
 *   - Generic parameters <WatchdogStatus> and <WatchdogFinding[]> tell
 *     TypeScript the shape of `data`. Generics are placeholder types the
 *     caller fills in.
 *   - `refresh()` just invokes both refetch functions in sequence.
 *   - `deleteFindings` / `clearAll` are plain async functions that POST/
 *     DELETE to the backend and then re-fetch so the UI reflects the
 *     server's new state.
 *
 * Connects to:
 *   - Backend: GET /api/watchdog, GET /api/watchdog/recent,
 *     POST /api/watchdog/findings/delete, DELETE /api/watchdog/findings —
 *     all defined in road_safety/server.py.
 *   - UI: not currently imported by any page (the app uses WatchdogContext
 *     instead via useWatchdogCtx in MonitoringPage.tsx). Kept as a simpler
 *     stand-alone alternative.
 */
import { usePolling } from "./usePolling";
import { api } from "../lib/api";
import type { WatchdogStatus, WatchdogFinding } from "../types";

export function useWatchdog() {
  const { data: status, refetch: refreshStatus } = usePolling<WatchdogStatus>({
    fetcher: api.getWatchdogStatus,
    intervalMs: 15_000,
  });

  const { data: findings, refetch: refreshFindings } = usePolling<WatchdogFinding[]>({
    fetcher: () => api.getWatchdogRecent(100),
    intervalMs: 30_000,
  });

  const refresh = () => {
    refreshStatus();
    refreshFindings();
  };

  const deleteFindings = async (keys: string[]) => {
    await api.deleteWatchdogFindings(keys);
    refresh();
  };

  const clearAll = async () => {
    await api.clearWatchdogFindings();
    refresh();
  };

  return { status, findings, refresh, deleteFindings, clearAll };
}
