/**
 * useTests — polls `/api/tests/status` with an ADAPTIVE interval: fast
 * (1.5s) while a test run is in progress, slow (10s) while idle. Also
 * exposes `rerun()` which kicks off a new run and immediately re-polls.
 *
 * TEACH: This hook is a good example of why you sometimes need two
 * useEffects instead of one. Effect #1 starts polling on mount at a
 * default rate. Effect #2 restarts the interval whenever the `status`
 * field changes — so the moment a run transitions idle→running we speed
 * the poll up (and slow back down when it finishes). Each effect returns
 * its own `clearInterval` cleanup, and React runs the old cleanup BEFORE
 * the new effect, so we never accumulate intervals.
 *
 * Return shape:
 *   { status, rerun, refetch }
 *   - `status`  — TestStatus | null
 *   - `rerun`   — kicks off a server-side test run then polls
 *   - `refetch` — manual one-shot poll
 *
 * Consumers:
 *   - pages/DashboardPage.tsx
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/api";
import type { TestStatus } from "../types";

export function useTests() {
  // --- Local state ---
  const [status, setStatus] = useState<TestStatus | null>(null);

  // TEACH: useRef used here as a "latest value" box for the initial
  // mount-time interval choice. Ref mutation doesn't re-render, so we can
  // update it from inside `poll` without triggering work; effects that
  // read `.current` just see the latest value next time they run.
  const lastStatusRef = useRef<string>("idle");

  // --- Polling fn ---
  // TEACH: useCallback with `[]` deps gives a permanently stable identity
  // — safe because `poll` only uses setters (stable) and the ref.
  const poll = useCallback(async () => {
    try {
      const data = await api.getTestStatus();
      setStatus(data);
      lastStatusRef.current = data.status;
    } catch {
      /* silent — don't surface transient errors on this admin tile */
    }
  }, []);

  // --- Effect #1: mount-time polling ---
  // TEACH: `useEffect(fn, [poll])` runs after the first render, and again
  // only if `poll` changes. Since `poll` is memoized with `[]`, this
  // effectively runs once on mount. The cleanup clears the interval when
  // the component unmounts OR before effect #2 replaces it.
  useEffect(() => {
    poll();
    const intervalMs = lastStatusRef.current === "running" ? 1500 : 10000;
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll]);

  // --- Effect #2: react to status changes with an adaptive interval ---
  // TEACH: The deps array includes `status?.status` (not the whole
  // `status` object). Including only the primitive we care about prevents
  // the effect from re-running when other fields inside `status` change
  // (e.g. a new `updated_at` timestamp) — we only want to retune the
  // interval when running-ness flips.
  useEffect(() => {
    if (!status) return;
    const intervalMs = status.status === "running" ? 1500 : 10000;
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [status?.status, poll]);

  // --- rerun(): server-side kick then immediate re-poll ---
  const rerun = useCallback(async () => {
    await api.runTests();
    poll();
  }, [poll]);

  return { status, rerun, refetch: poll };
}
