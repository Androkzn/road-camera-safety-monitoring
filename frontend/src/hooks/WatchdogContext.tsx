/**
 * WatchdogContext — shares one live watchdog poll across the whole app
 * via React Context, so every page / component that needs the data reads
 * from a SINGLE polling loop instead of each opening its own.
 *
 * ------------------------------------------------------------------
 * TEACH: React Context in three parts
 * ------------------------------------------------------------------
 *   1. `const Ctx = createContext(defaultValue)` — creates a Context
 *      object. `defaultValue` is only used when a consumer is rendered
 *      OUTSIDE any `<Ctx.Provider>`. In a real app you still want the
 *      default to be a valid shape (we use all-null fields) so consumers
 *      don't have to null-check the context object itself.
 *
 *   2. `<Ctx.Provider value={...}>{children}</Ctx.Provider>` — wraps a
 *      subtree. Any descendant that calls `useContext(Ctx)` gets that
 *      `value`. Re-rendering the provider with a new `value` re-renders
 *      every consumer. Mount the provider HIGH in the tree (here: in
 *      main.tsx around <App/>) so everyone below it can read.
 *
 *   3. `useContext(Ctx)` — inside a component, returns the current value
 *      from the nearest matching Provider. This is how you actually read
 *      the shared state.
 *
 * TEACH: Why we bother with Context here (rather than just calling
 * useWatchdog() in every consumer): each usePolling call creates its own
 * setInterval + fetch. Five components calling the raw hook = 5× the
 * network traffic on the same data. Centralising in a Provider gives us
 * one poll, many readers.
 *
 * TEACH: A ".tsx" file is TypeScript + JSX; plain ".ts" files can't
 * contain `<Foo>` syntax. That's the only reason this file uses .tsx
 * while the rest of the hooks folder is .ts.
 *
 * Consumers:
 *   - main.tsx              (mounts <WatchdogProvider> around <App/>)
 *   - components/layout/TopBar.tsx        (reads `status`)
 *   - pages/MonitoringPage.tsx            (reads status/findings,
 *                                          calls deleteFindings/clearAll)
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

// --- Context object with safe "no provider" defaults ---
// If a consumer renders outside <WatchdogProvider> (e.g. in a test) it will
// get these no-op values rather than crashing on `.status` of undefined.
const Ctx = createContext<WatchdogCtx>({
  status: null,
  findings: null,
  refresh: () => {},
  deleteFindings: async () => {},
  clearAll: async () => {},
});

// Fetches status + recent findings in parallel; one poll tick, two requests.
// Using Promise.all means the hook waits for BOTH before updating `data`,
// so the UI never displays a half-updated view.
async function fetchBoth(): Promise<WatchdogData> {
  const [status, findings] = await Promise.all([
    api.getWatchdogStatus(),
    api.getWatchdogRecent(100),
  ]);
  return { status, findings };
}

// --- Provider: owns the poll, exposes the value ---
export function WatchdogProvider({ children }: { children: ReactNode }) {
  // Single shared poll — runs once regardless of how many consumers mount.
  const { data, refetch } = usePolling<WatchdogData>({
    fetcher: fetchBoth,
    intervalMs: 15_000,
  });

  // --- Stable callbacks exposed through the context value ---
  // TEACH: useCallback(fn, deps) returns the SAME function reference across
  // renders as long as deps don't change. We use it here because `value`
  // below will be read by potentially many consumers. Stable function
  // identities prevent a "ripple re-render" storm when consumers depend on
  // these functions in their own effect deps. (`refetch` from usePolling is
  // already stable via its own useCallback.)
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
        // `data` is null until the first poll returns; expose null fields
        // so consumers can render a loading skeleton off a single check.
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

// --- Consumer hook ---
// TEACH: Exposing `useContext(Ctx)` behind a named hook is a convention:
// consumers import `useWatchdogCtx` rather than both `Ctx` and
// `useContext`, and we could add asserts (e.g. throw if default sentinel
// is returned) in one place if we ever want to forbid use outside the
// Provider.
export function useWatchdogCtx() {
  return useContext(Ctx);
}
