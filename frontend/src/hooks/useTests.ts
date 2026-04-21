/**
 * useTests.ts — custom hook that polls the backend test runner status and
 * can trigger a new test run.
 *
 * What it does:
 *   Polls /api/tests/status on an adaptive interval — every 1.5 seconds
 *   while tests are running, every 10 seconds otherwise — and exposes the
 *   latest TestStatus, a rerun() function that POSTs /api/tests/run then
 *   refetches, and a manual refetch().
 *
 * Purpose:
 *   Powers the dashboard's test badge and drawer: shows pass/fail counts,
 *   live progress while tests run, and a "rerun" button.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use` that
 *     packages state + effects for a caller component.
 *   - useState: stores the latest TestStatus so the caller re-renders when
 *     it changes.
 *   - useRef: `lastStatusRef` holds the previous status string WITHOUT
 *     triggering a re-render — useRef is for values that must survive
 *     renders but shouldn't themselves cause one.
 *   - useCallback: caches the `poll` function so its identity is stable
 *     across renders.
 *   - Two useEffect blocks together keep the polling cadence correct:
 *     one runs once on mount to start the loop, and the second swaps the
 *     interval whenever `status.status` flips between running and not.
 *     A useEffect is "code that runs after render" — it sets things up
 *     and returns a cleanup function that undoes them.
 *
 * Connects to:
 *   - Backend: GET /api/tests/status and POST /api/tests/run (both in
 *     road_safety/server.py).
 *   - UI: used by frontend/src/pages/DashboardPage.tsx, feeding
 *     frontend/src/components/tests/TestBadge.tsx (header pill) and
 *     frontend/src/components/tests/TestDrawer.tsx (slide-out panel).
 */
// React imports: useState re-renders; useEffect runs side-effects; useCallback memoizes a function; useRef is a mutable box.
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/api";
// `type`-only import: erased at build time.
import type { TestStatus } from "../types";

// useTests — polls GET /api/tests/status adaptively (1.5s while running, 10s idle); returns { status, rerun, refetch }.
// Consumed by: frontend/src/pages/DashboardPage.tsx — drives <TestBadge/> and <TestDrawer/>.
export function useTests() {
  // Latest TestStatus object (pass/fail counts, running flag, etc.); null until the first fetch succeeds.
  const [status, setStatus] = useState<TestStatus | null>(null);
  // Mirrors the last-seen status string without causing re-renders; used on first mount before `status` is set.
  const lastStatusRef = useRef<string>("idle");

  // Memoized fetcher; silent on error so the badge just keeps its last known state instead of flashing.
  const poll = useCallback(async () => {
    try {
      const data = await api.getTestStatus();
      setStatus(data);
      lastStatusRef.current = data.status;
    } catch {
      /* silent */
    }
  }, []);

  // Mount-only loop: deps [poll] and poll is stable so this runs once on mount.
  // setInterval starts the cadence; cleanup clearInterval runs on unmount or before the effect re-runs.
  useEffect(() => {
    poll();
    const intervalMs = lastStatusRef.current === "running" ? 1500 : 10000;
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll]);

  // Cadence-swap loop: deps [status?.status, poll] re-run whenever the tests flip between running/idle,
  // so we replace the interval with the right speed. `?.` = read `.status` only if `status` is not null.
  useEffect(() => {
    if (!status) return;
    const intervalMs = status.status === "running" ? 1500 : 10000;
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [status?.status, poll]);

  // `rerun` POSTs /api/tests/run then immediately refetches so the UI reflects the new "running" state without waiting.
  const rerun = useCallback(async () => {
    await api.runTests();
    poll();
  }, [poll]);

  return { status, rerun, refetch: poll };
}
