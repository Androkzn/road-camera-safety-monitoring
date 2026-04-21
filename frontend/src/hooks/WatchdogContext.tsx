/**
 * WatchdogContext.tsx — app-wide shared store for watchdog status + findings.
 *
 * What it does:
 *   Polls the backend every 15 seconds for both the watchdog status summary
 *   and the most recent 100 findings in parallel, then exposes that data
 *   plus delete/clear helpers to any child component via React Context.
 *
 * Purpose:
 *   Several parts of the UI (e.g. MonitoringPage, future nav badges) need
 *   the same watchdog data. Instead of each polling independently, we poll
 *   once here and share the result with descendants, avoiding duplicate
 *   network calls and keeping numbers consistent across the UI.
 *
 * How it works:
 *   - React Context: a built-in mechanism to "broadcast" values down the
 *     component tree without manually passing props. createContext() makes
 *     a context object, <Ctx.Provider value=...> publishes a value, and
 *     useContext(Ctx) reads that value from anywhere inside the provider.
 *   - WatchdogProvider is a component that wraps children; mount it once
 *     near the app root (done in main.tsx).
 *   - usePolling() is a generic helper (see usePolling.ts); the generic
 *     parameter <WatchdogData> — angle brackets filling a placeholder —
 *     tells TypeScript what shape `data` has.
 *   - useCallback: caches refresh/delete/clear functions so consumers that
 *     depend on them don't re-render unnecessarily.
 *   - fetchBoth() uses Promise.all to run both HTTP calls concurrently.
 *   - useWatchdogCtx() is the custom-hook shortcut consumers call instead
 *     of useContext(Ctx) directly.
 *
 * Connects to:
 *   - Backend: GET /api/watchdog, GET /api/watchdog/recent?n=100,
 *     POST /api/watchdog/findings/delete, DELETE /api/watchdog/findings
 *     — all defined in road_safety/server.py.
 *   - UI: <WatchdogProvider> wraps the whole app in frontend/src/main.tsx.
 *     Consumers: frontend/src/pages/MonitoringPage.tsx (via useWatchdogCtx).
 */
import { createContext, useContext, useCallback, type ReactNode } from "react";
import { usePolling } from "./usePolling";
import { api } from "../lib/api";
import type { WatchdogStatus, WatchdogFinding } from "../types";

interface WatchdogData {
  status: WatchdogStatus;
  findings: WatchdogFinding[];
}

interface WatchdogCtx {
  status: WatchdogStatus | null;
  findings: WatchdogFinding[] | null;
  refresh: () => void;
  deleteFindings: (keys: string[]) => Promise<void>;
  clearAll: () => Promise<void>;
}

const Ctx = createContext<WatchdogCtx>({
  status: null,
  findings: null,
  refresh: () => {},
  deleteFindings: async () => {},
  clearAll: async () => {},
});

async function fetchBoth(): Promise<WatchdogData> {
  const [status, findings] = await Promise.all([
    api.getWatchdogStatus(),
    api.getWatchdogRecent(100),
  ]);
  return { status, findings };
}

export function WatchdogProvider({ children }: { children: ReactNode }) {
  const { data, refetch } = usePolling<WatchdogData>({
    fetcher: fetchBoth,
    intervalMs: 15_000,
  });

  const refresh = useCallback(() => { refetch(); }, [refetch]);

  const deleteFindings = useCallback(async (keys: string[]) => {
    await api.deleteWatchdogFindings(keys);
    refetch();
  }, [refetch]);

  const clearAll = useCallback(async () => {
    await api.clearWatchdogFindings();
    refetch();
  }, [refetch]);

  return (
    <Ctx.Provider
      value={{
        status: data?.status ?? null,
        findings: data?.findings ?? null,
        refresh,
        deleteFindings,
        clearAll,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useWatchdogCtx() {
  return useContext(Ctx);
}
