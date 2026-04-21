/**
 * Watchdog API — findings list + destructive clears (POC: unauthenticated).
 *
 * `AbortSignal` is part of the fetch API — passing it lets TanStack
 * cancel in-flight requests when the component unmounts or refetches.
 */
import { apiFetch } from "../../shared/lib/fetchClient";

import type { WatchdogFinding, WatchdogStatus } from "../../shared/types/common";

/**
 * Thin endpoint wrappers. Generic `<T>` on apiFetch fixes the return
 * type of the parsed JSON; callers get full TS autocomplete.
 */
export const watchdogApi = {
  getStatus: (signal?: AbortSignal) => apiFetch<WatchdogStatus>("/api/watchdog", { signal }),

  getRecent: (n: number, signal?: AbortSignal) =>
    apiFetch<WatchdogFinding[]>(`/api/watchdog/recent?n=${n}`, { signal }),

  deleteFindings: (keys: string[]) =>
    apiFetch<{ deleted: number }>("/api/watchdog/findings/delete", {
      method: "POST",
      body: JSON.stringify({ keys }),
    }),

  clearAll: () =>
    apiFetch<{ deleted: number }>("/api/watchdog/findings?clear_all=true", {
      method: "DELETE",
    }),
};

/** Shared TanStack Query cache key for the combined status + findings query. */
export const watchdogQueryKeys = {
  combined: ["watchdog", "combined"] as const,
};
