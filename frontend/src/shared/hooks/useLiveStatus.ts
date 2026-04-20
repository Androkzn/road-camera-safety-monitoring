/**
 * useLiveStatus — TanStack Query wrapper for `/api/live/status`.
 *
 * Used by Dashboard / Monitoring / Settings — the source-of-truth for
 * "is the perception loop alive" and the source name that the TopBar
 * displays. With React Query this query is automatically deduped across
 * pages and refetched on window focus.
 */
import { useQuery } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../config/runtime";
import { fetchJson } from "../lib/fetchClient";
import type { LiveStatus } from "../types/common";

export const liveStatusQueryKey = ["shared", "liveStatus"] as const;

export function useLiveStatus(refetchIntervalMs: number = POLL_INTERVAL_MS.liveStatus) {
  return useQuery({
    queryKey: liveStatusQueryKey,
    queryFn: ({ signal }) => fetchJson<LiveStatus>("/api/live/status", { signal }),
    refetchInterval: refetchIntervalMs,
  });
}
