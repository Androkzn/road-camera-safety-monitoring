/**
 * Admin API surface — health snapshot, live sources lifecycle, history.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the data-access layer that
 *   the admin page's hooks call to populate the health pills, the video
 *   grid tiles, the live event list, and the history list.
 * Backend: GET /api/admin/health, GET/POST/DELETE /api/live/sources,
 *   GET /api/live/events.
 */
import { LIMITS } from "../../shared/config/runtime";
import { fetchJson } from "../../shared/lib/fetchClient";
import type {
  HealthData,
  LiveSourceStatus,
  LiveSourcesResponse,
  SafetyEvent,
} from "../../shared/types/common";

/**
 * adminApi — thin fetch wrappers around the admin-page REST surface.
 *
 * Consumed by the TanStack Query hooks in `features/admin/hooks/`
 * (useAdminHealth, useLiveSources) and by HistoryPanel for the events list.
 * Each wrapper accepts an optional AbortSignal so the caller can cancel on
 * unmount / query invalidation.
 */
export const adminApi = {
  // GET /api/admin/health — server + per-source perception snapshot.
  // Drives the HealthStrip + uptime pill on AdminPage.
  getHealth: (signal?: AbortSignal) => fetchJson<HealthData>("/api/admin/health", { signal }),

  // GET /api/live/sources — list of configured perception sources +
  // which one the backend considers primary. Feeds MultiSourceGrid.
  getLiveSources: (signal?: AbortSignal) =>
    fetchJson<LiveSourcesResponse>("/api/live/sources", { signal }),
  // POST /api/live/sources/{id}/start — resume perception for a source.
  startLiveSource: (id: string) =>
    fetchJson<LiveSourceStatus>(`/api/live/sources/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),
  // POST /api/live/sources/{id}/pause — pause perception but keep the slot.
  pauseLiveSource: (id: string) =>
    fetchJson<LiveSourceStatus>(`/api/live/sources/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    }),
  // POST /api/live/sources/{id}/detection?enabled=... — toggle YOLO/tracking
  // on the source without tearing the stream down (lets the grid stay live
  // while skipping heavy perception work on that tile).
  setLiveSourceDetection: (id: string, enabled: boolean) =>
    fetchJson<LiveSourceStatus>(
      `/api/live/sources/${encodeURIComponent(id)}/detection?enabled=${enabled}`,
      { method: "POST" },
    ),
  // POST /api/live/sources — register a new perception source from the
  // "Add source" form. The `ok`/`error` fields let the UI surface a rejection
  // (e.g. SSRF guard or bad URL) without throwing.
  addLiveSource: (body: { url: string; name?: string; id?: string; autostart?: boolean }) =>
    fetchJson<LiveSourceStatus & { ok: boolean; error?: string }>("/api/live/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  // DELETE /api/live/sources/{id} — remove a source entirely. The query cache
  // is invalidated by the caller on success so the grid tile disappears.
  removeLiveSource: (id: string) =>
    fetchJson<{ ok: boolean; removed: string }>(`/api/live/sources/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // GET /api/live/events — recent SafetyEvents with optional filters. Used by
  // HistoryPanel's query; SSE handles the real-time feed separately so this
  // is only for backfill / risk-level filtering.
  getLiveEvents: (
    params?: {
      risk_level?: string;
      event_type?: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (params?.risk_level) q.set("risk_level", params.risk_level);
    if (params?.event_type) q.set("event_type", params.event_type);
    q.set("limit", String(params?.limit ?? LIMITS.liveEventsDefaultLimit));
    return fetchJson<SafetyEvent[]>(`/api/live/events?${q}`, { signal });
  },
};

/**
 * adminQueryKeys — stable TanStack Query cache keys for the admin feature.
 * Centralised so invalidation (e.g. after start/pause/add/remove mutations)
 * can target the same key the fetching hook uses.
 */
export const adminQueryKeys = {
  health: ["admin", "health"] as const,
  liveSources: ["admin", "liveSources"] as const,
};
