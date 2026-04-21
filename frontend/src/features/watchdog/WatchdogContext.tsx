/**
 * WatchdogContext — shared TanStack Query for status + findings.
 *
 * Provider/consumer pattern: mount <WatchdogProvider> once near the
 * app root, then any descendant calls useWatchdogCtx() to read the
 * cached data without triggering additional HTTP requests.
 *
 * --- UI mapping ---
 * Page: Global (TopBar of every page).
 * UI element: the React context that shares watchdog state (status +
 *   findings) across the app — feeds the TopBar watchdog badge and the
 *   WatchdogDrawer.
 * Backend: GET /api/watchdog, GET /api/watchdog/recent (via watchdogApi).
 */
// `createContext` + `useContext` are React's built-in dependency-injection
// pair. `useCallback` memoizes a function reference across renders (useful
// when the function is passed as a prop or a hook dep). `type ReactNode`
// is the union type for "anything renderable" — used for the `children` prop.
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LIMITS, POLL_INTERVAL_MS, STALE_TIME_MS } from "../../shared/config/runtime";
import { dialog } from "../../shared/ui";
import type { WatchdogFinding, WatchdogStatus } from "../../shared/types/common";

import { watchdogApi, watchdogQueryKeys } from "./api";

/** Internal combined payload fetched by a single TanStack query. */
interface WatchdogData {
  status: WatchdogStatus;
  findings: WatchdogFinding[];
}

/**
 * Shape exposed to consumers via {@link useWatchdogCtx}. Note the
 * nullable data (still loading) and promise-returning mutators.
 */
interface WatchdogCtx {
  status: WatchdogStatus | null;
  findings: WatchdogFinding[] | null;
  refresh: () => void;
  deleteFindings: (keys: string[]) => Promise<void>;
  clearAll: () => Promise<void>;
}

// Default context value — used if a component calls useWatchdogCtx()
// without a surrounding provider. In practice the provider is always
// mounted; the defaults are just safety.
const Ctx = createContext<WatchdogCtx>({
  status: null,
  findings: null,
  refresh: () => {},
  deleteFindings: async () => {},
  clearAll: async () => {},
});

/**
 * Fetch status + recent findings in parallel. `Promise.all` lets both
 * HTTP calls run concurrently and resolves when both complete.
 */
async function fetchBoth(signal?: AbortSignal): Promise<WatchdogData> {
  const [status, findings] = await Promise.all([
    watchdogApi.getStatus(signal),
    watchdogApi.getRecent(LIMITS.watchdogRecent, signal),
  ]);
  return { status, findings };
}

/**
 * Log to console + surface a dialog when a mutation fails. `unknown`
 * is TS's safer alternative to `any` — forces the caller to narrow the
 * type before using it (hence the `as Error` cast below).
 */
function handleWatchdogError(exc: unknown, action: string): void {
  console.error(exc);
  // `void` keyword: discards the promise result so an un-awaited call
  // doesn't leak into eslint no-floating-promises warnings.
  void dialog.alert({
    title: `${action} failed`,
    message: (exc as Error)?.message ?? "unknown error",
    variant: "danger",
  });
}

/**
 * Provider component — wraps the app subtree and seeds the context.
 * Any descendant that calls {@link useWatchdogCtx} will share the
 * same query cache entry, so the polling cost is paid once.
 */
export function WatchdogProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: watchdogQueryKeys.combined,
    queryFn: ({ signal }) => fetchBoth(signal),
    refetchInterval: POLL_INTERVAL_MS.watchdog,
    staleTime: STALE_TIME_MS.watchdog,
  });

  // `useCallback` keeps the same function identity across renders so
  // consumers comparing deps (useEffect, memo) don't see spurious changes.
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // Two mutations: delete-selected and clear-all. Both invalidate the
  // shared query on success, triggering an automatic refetch.
  const deleteMutation = useMutation({
    mutationFn: (keys: string[]) => watchdogApi.deleteFindings(keys),
    onSuccess: () => qc.invalidateQueries({ queryKey: watchdogQueryKeys.combined }),
  });

  const clearMutation = useMutation({
    mutationFn: () => watchdogApi.clearAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: watchdogQueryKeys.combined }),
  });

  const deleteFindings = useCallback(
    async (keys: string[]) => {
      try {
        await deleteMutation.mutateAsync(keys);
      } catch (exc) {
        handleWatchdogError(exc, "Delete findings");
      }
    },
    [deleteMutation],
  );

  const clearAll = useCallback(async () => {
    try {
      await clearMutation.mutateAsync();
    } catch (exc) {
      handleWatchdogError(exc, "Clear all findings");
    }
  }, [clearMutation]);

  // Memoize the context value object so consumers don't re-render on
  // every provider render just because a new object literal was created.
  const value = useMemo<WatchdogCtx>(
    () => ({
      status: data?.status ?? null,
      findings: data?.findings ?? null,
      refresh,
      deleteFindings,
      clearAll,
    }),
    [data?.status, data?.findings, refresh, deleteFindings, clearAll],
  );

  // Inject `value` into the tree. Any descendant that calls useContext(Ctx)
  // — i.e. useWatchdogCtx() — receives this exact object.
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Hook used by features to read watchdog state. Kept as a named export
 * so lint rules and VS Code's "Find References" work cleanly.
 */
export function useWatchdogCtx() {
  return useContext(Ctx);
}
