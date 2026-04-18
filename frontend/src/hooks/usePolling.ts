/**
 * usePolling — generic "fetch every N ms" custom hook.
 *
 * TEACH: A "custom hook" in React is any function whose name starts with `use`
 * and which may call other hooks (`useState`, `useEffect`, ...). It is just a
 * plain function — nothing magic — but the naming prefix triggers React's
 * lint rules that enforce the Rules of Hooks (call at the top level of a
 * component, same order every render, never inside conditionals/loops).
 * Custom hooks let multiple components share stateful logic without having
 * to copy/paste the same `useState`+`useEffect` plumbing.
 *
 * Return shape:
 *   { data, error, refetch }
 *   - `data`    — the latest T returned by `fetcher()`, or `null` before the
 *                 first successful call.
 *   - `error`   — the last Error thrown, cleared on the next success.
 *   - `refetch` — an imperative "fetch right now" function that callers can
 *                 invoke after mutations (e.g. after a DELETE).
 *
 * Consumers (all of the thin wrappers in this folder go through this hook):
 *   - useAdminHealth, useLiveStatus, useScene, useDrift, useWatchdog and the
 *     provider in WatchdogContext.tsx.
 *   - Indirectly reached by pages/AdminPage.tsx, pages/DashboardPage.tsx,
 *     pages/MonitoringPage.tsx.
 *
 * React concepts introduced in this file (read these in order):
 *   - useState             (local, reactive value with a setter)
 *   - useRef               (mutable box that does NOT trigger re-render)
 *   - useCallback          (stable function identity across renders)
 *   - useEffect + cleanup  (side-effect after render, cleanup before next)
 *   - setInterval + clearInterval inside an effect (subscription lifecycle)
 */
import { useEffect, useRef, useCallback, useState } from "react";

interface UsePollingOptions<T> {
  fetcher: () => Promise<T>;
  intervalMs: number;
  enabled?: boolean;
  immediate?: boolean;
}

export function usePolling<T>({
  fetcher,
  intervalMs,
  enabled = true,
  immediate = true,
}: UsePollingOptions<T>) {
  // --- Local state ---
  // TEACH: useState(initial) returns a tuple [value, setter]. Calling the
  // setter queues a re-render with the new value. `initial` is only used on
  // the very first render; subsequent renders read the live value React has
  // stored for this component instance.
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // --- "Latest fetcher" ref (stale-closure guard) ---
  // TEACH: useRef(initial) returns an object `{ current: initial }` that is
  // STABLE across renders and mutating `.current` does NOT cause a re-render.
  // Two common uses: (a) holding a DOM node, (b) holding the "latest" version
  // of something a long-lived effect needs to call.
  //
  // Why we need it here: the caller passes a fresh `fetcher` function every
  // render (arrow functions are new objects each time). If the effect below
  // captured `fetcher` directly, it would either (i) capture a stale version
  // forever if we omit it from deps, or (ii) tear down and rebuild the
  // interval on every render if we include it. Stashing the latest fetcher
  // in a ref and reading `fetcherRef.current` inside `poll` lets us keep a
  // single long-lived interval while still calling the newest fetcher.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // --- Stable poll function ---
  // TEACH: useCallback(fn, deps) returns the SAME function reference across
  // renders as long as `deps` don't change. Useful when the function is
  // passed as a dep to useEffect or down to memoized children — otherwise a
  // new function identity each render would retrigger effects / re-renders.
  // Deps are `[]` here because `poll` only reads `fetcherRef.current` and
  // the setters (setters from useState are guaranteed stable by React).
  const poll = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  // --- Effect: start/stop the polling interval ---
  // TEACH: useEffect(fn, deps) runs `fn` AFTER the component has rendered to
  // the DOM, on mount and whenever any value in `deps` has changed since the
  // previous render. The function `fn` may return a cleanup function; React
  // calls that cleanup (a) before running the effect again, and (b) when the
  // component unmounts. Forgetting the cleanup is the #1 source of React
  // leaks — intervals keep firing, SSE stays open, listeners pile up.
  useEffect(() => {
    if (!enabled) return;

    if (immediate) {
      // Kick off one fetch right now so the UI isn't blank for `intervalMs`.
      poll();
    }

    const id = setInterval(poll, intervalMs);
    // Cleanup: clearInterval BEFORE next effect or on unmount, so we never
    // end up with two intervals if deps change mid-life.
    return () => clearInterval(id);
  }, [enabled, intervalMs, immediate, poll]);

  return { data, error, refetch: poll };
}
