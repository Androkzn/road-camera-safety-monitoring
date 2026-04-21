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
// Context pattern: `createContext` + `<Provider value={...}>` + `useContext` is React's way of sharing state
// with components deep in the tree without passing props down at every level.
// ReactNode is a type for anything renderable (JSX, strings, arrays, null); `type` import erases at build time.
import { createContext, useContext, useCallback, type ReactNode } from "react";
import { usePolling } from "./usePolling";
import { api } from "../lib/api";
import type { WatchdogStatus, WatchdogFinding } from "../types";

// Shape of the combined poll result.
interface WatchdogData {
  status: WatchdogStatus;
  findings: WatchdogFinding[];
}

// Shape published through Context. `T | null` (union) = either T or null — null before first poll resolves.
interface WatchdogCtx {
  status: WatchdogStatus | null;
  findings: WatchdogFinding[] | null;
  refresh: () => void;
  deleteFindings: (keys: string[]) => Promise<void>;
  clearAll: () => Promise<void>;
}

// createContext builds the channel and takes a default value used only when a component reads it without a Provider above.
const Ctx = createContext<WatchdogCtx>({
  status: null,
  findings: null,
  refresh: () => {},
  deleteFindings: async () => {},
  clearAll: async () => {},
});

// Helper: fetch both endpoints concurrently via Promise.all; returns the merged shape.
// Destructure `[status, findings]` from the resolved array of results.
async function fetchBoth(): Promise<WatchdogData> {
  const [status, findings] = await Promise.all([
    api.getWatchdogStatus(),
    api.getWatchdogRecent(100),
  ]);
  return { status, findings };
}

// WatchdogProvider — wraps the app (mounted in frontend/src/main.tsx) and publishes watchdog data via Context.
// Consumed by: frontend/src/pages/MonitoringPage.tsx (via useWatchdogCtx) for incident tiles + action queue.
export function WatchdogProvider({ children }: { children: ReactNode }) {
  // Single poll loop (see usePolling.ts) shared across all consumers — avoids duplicate network calls.
  const { data, refetch } = usePolling<WatchdogData>({
    fetcher: fetchBoth,
    intervalMs: 15_000,
  });

  // Stable identity so consumers depending on `refresh` don't re-render every tick.
  const refresh = useCallback(() => { refetch(); }, [refetch]);

  // Delete specific finding keys on the server, then refetch so the shared state matches.
  const deleteFindings = useCallback(async (keys: string[]) => {
    await api.deleteWatchdogFindings(keys);
    refetch();
  }, [refetch]);

  // Clear all findings on the server, then refetch.
  const clearAll = useCallback(async () => {
    await api.clearWatchdogFindings();
    refetch();
  }, [refetch]);

  // <Ctx.Provider value=...> makes the value visible to every useContext(Ctx) call inside {children}.
  // `data?.status ?? null` = optional chaining (read only if data exists) + nullish coalescing (fallback to null if undefined).
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

// useWatchdogCtx — the ergonomic accessor for consumers; returns the current Context value.
// Consumed by: frontend/src/pages/MonitoringPage.tsx.
export function useWatchdogCtx() {
  // useContext reads the nearest matching <Ctx.Provider> value above this component in the tree.
  return useContext(Ctx);
}
