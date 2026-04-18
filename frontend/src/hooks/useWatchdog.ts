/**
 * useWatchdog — pairs two usePolling calls (status at 15s, findings at 30s)
 * and exposes a combined API: read both, refresh both, delete / clear
 * findings via the admin endpoints.
 *
 * TEACH: You can call multiple hooks from one custom hook — React just
 * requires the ORDER of hook calls to be identical every render (no hooks
 * in `if`/`for`/early-return). Because each `usePolling` is called
 * unconditionally and in a fixed order, React can reliably associate its
 * internal state slots with each call.
 *
 * NOTE: This hook creates its own polling pair per consumer. If multiple
 * components both call `useWatchdog()` they will each poll independently —
 * see hooks/WatchdogContext.tsx for the shared-context alternative used
 * by the app shell (which is the one the real pages consume today).
 *
 * Return shape:
 *   {
 *     status, findings,         // latest data (null until first fetch)
 *     refresh,                  // re-fetch both
 *     deleteFindings(keys),     // DELETE then refresh
 *     clearAll(),               // DELETE-all then refresh
 *   }
 *
 * Consumers: currently unused directly by pages — kept as a standalone
 * alternative to `useWatchdogCtx()` (see WatchdogContext.tsx).
 *
 * See hooks/usePolling.ts for the React concept teaching (useState /
 * useEffect / useRef / useCallback / cleanup).
 */
import { usePolling } from "./usePolling";
import { api } from "../lib/api";
import type { WatchdogStatus, WatchdogFinding } from "../types";

export function useWatchdog() {
  // Two independent polls — each has its own state, interval, and cleanup.
  const { data: status, refetch: refreshStatus } = usePolling<WatchdogStatus>({
    fetcher: api.getWatchdogStatus,
    intervalMs: 15_000,
  });

  const { data: findings, refetch: refreshFindings } = usePolling<WatchdogFinding[]>({
    // Arrow wrapper because the fetcher takes a fixed limit argument.
    fetcher: () => api.getWatchdogRecent(100),
    intervalMs: 30_000,
  });

  // NOTE: `refresh` / `deleteFindings` / `clearAll` are plain closures, not
  // wrapped in useCallback. That's fine because this hook doesn't hand them
  // to memoized children or dependency arrays that care about identity. If
  // you ever pass them to React.memo'd children, wrap them in useCallback
  // to keep referential stability (see WatchdogContext.tsx for that style).
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
