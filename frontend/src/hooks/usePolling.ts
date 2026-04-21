/**
 * usePolling.ts — generic hook that calls a fetcher on a timer interval.
 *
 * What it does:
 *   Given any async fetcher function and an interval in milliseconds, calls
 *   the fetcher immediately, then re-calls it on a repeating setInterval.
 *   Exposes the latest result, the latest error, and a manual refetch().
 *
 * Purpose:
 *   The DRY core for every polling-based API hook in the app (admin health,
 *   live status, scene, drift, watchdog). Having one place that handles
 *   interval setup, cleanup, and error capture avoids repeating that
 *   boilerplate in each hook.
 *
 * How it works:
 *   - This is a "custom hook": a function starting with `use` that bundles
 *     React state + effects into a reusable unit.
 *   - Generics: `usePolling<T>` has a placeholder type T. The caller fills
 *     it in (e.g. usePolling<HealthData>) so `data` is correctly typed as
 *     `T | null`.
 *   - useState holds `data` and `error`, so updates re-render the caller.
 *   - useRef holds a value that survives renders without causing re-renders;
 *     we stash the latest `fetcher` in `fetcherRef` so the setInterval
 *     always calls the newest version even if props changed.
 *   - useCallback caches the `poll` function; useEffect then sets up the
 *     setInterval (and optionally runs once immediately via `immediate`),
 *     and the returned cleanup function clearInterval()s it when the
 *     component unmounts or the interval/enabled flag changes.
 *   - The `enabled` flag lets callers pause polling conditionally.
 *
 * Connects to:
 *   - Backend: none directly — the caller passes a fetcher that hits the
 *     right API endpoint in road_safety/server.py.
 *   - UI: used internally by useAdminHealth, useLiveStatus, useScene,
 *     useDrift, useWatchdog, and WatchdogContext.
 */
// React imports: useEffect = run side-effects after render; useRef = mutable box that survives renders;
// useCallback = memoized function; useState = value that, when changed, re-renders the component.
import { useEffect, useRef, useCallback, useState } from "react";

// Options shape. `<T>` is a generic (placeholder type) the caller fills in so `fetcher` returns the right type.
// The `?` after a field makes it optional.
interface UsePollingOptions<T> {
  fetcher: () => Promise<T>;
  intervalMs: number;
  enabled?: boolean;
  immediate?: boolean;
}

// usePolling — generic polling primitive; returns { data, error, refetch } to any caller.
// Building block used by useAdminHealth, useLiveStatus, useScene, useDrift, useWatchdog, WatchdogContext.
export function usePolling<T>({
  fetcher,
  intervalMs,
  enabled = true,
  immediate = true,
}: UsePollingOptions<T>) {
  // Latest fetched value. `T | null` (union type) means "either T or null"; flips to T after first success.
  const [data, setData] = useState<T | null>(null);
  // Latest error (or null). Changes whenever a fetch throws or a fetch succeeds again.
  const [error, setError] = useState<Error | null>(null);
  // useRef box keeps the newest fetcher without triggering re-renders, so the interval always calls fresh code.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // useCallback memoizes `poll` so its identity is stable across renders (dep [] = created once).
  // Runs fetcher, stores result in `data` or error in `error`.
  const poll = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  // useEffect runs after render. The dependency array [enabled, intervalMs, immediate, poll] means:
  // re-run whenever any of these change. The returned function is cleanup, run on unmount or before re-run.
  useEffect(() => {
    if (!enabled) return;

    // Optional first-tick fetch so the UI doesn't wait `intervalMs` for its first data.
    if (immediate) {
      poll();
    }

    // setInterval schedules `poll` every intervalMs ms; clearInterval stops it on cleanup/unmount.
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, immediate, poll]);

  // Expose the polled state plus a manual `refetch` (same function as `poll`) for buttons etc.
  return { data, error, refetch: poll };
}
