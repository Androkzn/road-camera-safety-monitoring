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
// `type`-only import: erased at build time.
import type { WatchdogStatus, WatchdogFinding } from "../types";

// useWatchdog — standalone polling hook; returns { status, findings, refresh, deleteFindings, clearAll }.
// Currently unused by any page — the app uses WatchdogContext via useWatchdogCtx in MonitoringPage.tsx instead.
// Kept as a self-contained alternative for tests or future pages that want their own copy.
export function useWatchdog() {
  // Poll the status summary every 15s. `<WatchdogStatus>` generic tells usePolling the data shape.
  // Destructure + rename: `data: status` means "the field named data, but call it status here".
  const { data: status, refetch: refreshStatus } = usePolling<WatchdogStatus>({
    fetcher: api.getWatchdogStatus,
    intervalMs: 15_000,
  });

  // Poll the last 100 findings every 30s (slower cadence — findings change less often than status).
  // Numeric separator `15_000` is just a readability aid for 15000.
  const { data: findings, refetch: refreshFindings } = usePolling<WatchdogFinding[]>({
    fetcher: () => api.getWatchdogRecent(100),
    intervalMs: 30_000,
  });

  // Trigger both refetches at once (e.g. when a refresh button is clicked).
  const refresh = () => {
    refreshStatus();
    refreshFindings();
  };

  // Mutating endpoint: delete specific finding keys, then refetch so the UI matches server state.
  const deleteFindings = async (keys: string[]) => {
    await api.deleteWatchdogFindings(keys);
    refresh();
  };

  // Mutating endpoint: clear everything, then refetch.
  const clearAll = async () => {
    await api.clearWatchdogFindings();
    refresh();
  };

  return { status, findings, refresh, deleteFindings, clearAll };
}
