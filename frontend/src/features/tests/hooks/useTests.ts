/**
 * useTests — TanStack Query wrapper around the pytest runner status.
 *
 * The poll interval flips between fast (1.5s) while a run is in
 * progress and slow (10s) while idle. TanStack supports per-call
 * function-form `refetchInterval` so we don't need a second effect.
 *
 * --- UI mapping ---
 * Page: Global (TopBar of every page).
 * UI element: Drives the TopBar tests badge (status + counts) and the
 *   rerun action exposed by the TestDrawer.
 * Backend: GET /api/tests/status (polled), POST /api/tests/run.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { POLL_INTERVAL_MS, STALE_TIME_MS } from "../../../shared/config/runtime";
import { testsApi, testsQueryKeys } from "../api";
import type { TestStatus } from "../../../shared/types/common";

/**
 * Hook exposing the latest test-run status plus a rerun trigger.
 *
 * @returns `{ status, rerun, refetch }` — `status` is null until the
 * first poll lands; `rerun()` returns a promise that resolves once the
 * POST lands (not when the run actually finishes).
 */
export function useTests() {
  const qc = useQueryClient();
  const { data: status, refetch } = useQuery<TestStatus>({
    queryKey: testsQueryKeys.status,
    queryFn: ({ signal }) => testsApi.getStatus(signal),
    // Function-form `refetchInterval` is re-evaluated after every fetch,
    // so we can speed up polling while a run is live then slow down.
    refetchInterval: (query) =>
      query.state.data?.status === "running"
        ? POLL_INTERVAL_MS.testsRunning
        : POLL_INTERVAL_MS.testsIdle,
    staleTime: STALE_TIME_MS.tests,
    refetchOnWindowFocus: true,
  });

  // POST /api/tests/run; on success invalidate the status query so
  // the UI flips to "Running" immediately instead of after the next poll.
  const rerun = useMutation({
    mutationFn: testsApi.run,
    onSuccess: () => qc.invalidateQueries({ queryKey: testsQueryKeys.status }),
  });

  return {
    status: status ?? null,
    rerun: () => rerun.mutateAsync(),
    refetch,
  };
}
