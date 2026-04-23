/**
 * useAdminHealth — TanStack Query for `/api/admin/health`.
 *
 * Why a custom hook? It wraps one `useQuery` call so callers get:
 *   - shared cache (any other component keyed on `adminQueryKeys.health`
 *     sees the same data without refetching),
 *   - automatic polling via `refetchInterval`,
 *   - request cancellation via the injected `AbortSignal`.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the polling data hook
 *   that feeds the row of green/yellow/red health pills at the top of
 *   the page (HealthStrip).
 * Backend: GET /api/admin/health (polled every ~5 s).
 */
// TEACH: `useQuery` is the core data-fetching hook from TanStack Query.
// It fetches once, caches by `queryKey`, and re-fetches on the schedule
// set by `refetchInterval`. Returns `{ data, isLoading, error, ... }`.
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { adminApi, adminQueryKeys } from "../api";

/**
 * Poll `/api/admin/health` every `refetchIntervalMs` (default: 5 s).
 * Returns the standard TanStack Query result object.
 *
 * @param refetchIntervalMs - override the poll cadence (e.g. slower when
 *   the hook is mounted in a background tab).
 */
export function useAdminHealth(refetchIntervalMs: number = POLL_INTERVAL_MS.adminHealth) {
  return useQuery({
    // TEACH: `queryKey` is how the cache is indexed. Two components
    // using the same key share the same data — one fetch, many readers.
    queryKey: adminQueryKeys.health,
    // TEACH: `signal` comes from TanStack Query; passing it into `fetch`
    // aborts the HTTP request if the component unmounts mid-flight.
    queryFn: ({ signal }) => adminApi.getHealth(signal),
    refetchInterval: refetchIntervalMs,
  });
}
