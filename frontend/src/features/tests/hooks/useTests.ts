/**
 * useTests — TanStack Query wrapper around the pytest runner status.
 *
 * The poll interval flips between fast (1.5s) while a run is in
 * progress and slow (10s) while idle. TanStack supports per-call
 * function-form `refetchInterval` so we don't need a second effect.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { POLL_INTERVAL_MS, STALE_TIME_MS } from "../../../shared/config/runtime";
import { testsApi, testsQueryKeys } from "../api";
import type { TestStatus } from "../../../shared/types/common";

export function useTests() {
  const qc = useQueryClient();
  const { data: status, refetch } = useQuery<TestStatus>({
    queryKey: testsQueryKeys.status,
    queryFn: ({ signal }) => testsApi.getStatus(signal),
    refetchInterval: (query) =>
      query.state.data?.status === "running"
        ? POLL_INTERVAL_MS.testsRunning
        : POLL_INTERVAL_MS.testsIdle,
    staleTime: STALE_TIME_MS.tests,
    refetchOnWindowFocus: true,
  });

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
