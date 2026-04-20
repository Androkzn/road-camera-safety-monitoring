/**
 * Watchdog API — findings list + destructive clears (POC: unauthenticated).
 */
import { apiFetch } from "../../shared/lib/fetchClient";

import type { WatchdogFinding, WatchdogStatus } from "../../shared/types/common";

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

export const watchdogQueryKeys = {
  combined: ["watchdog", "combined"] as const,
};
