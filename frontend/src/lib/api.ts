/**
 * api.ts — central HTTP client for all backend calls from the React UI.
 *
 * What it does:
 *   Defines a single `api` object whose methods wrap every REST endpoint the
 *   frontend talks to. Each method returns a typed Promise resolving to the
 *   JSON body (e.g. `LiveStatus`, `SafetyEvent[]`). A small `fetchJson<T>`
 *   helper handles the raw `fetch` call, disables caching, and throws on
 *   non-2xx responses.
 *
 * Purpose:
 *   Keeps URL strings and request shapes in one place so hooks/components
 *   never build raw `fetch()` calls. `<T>` is a TypeScript "generic" — the
 *   helper returns whatever type the caller asks for, so responses stay
 *   type-checked end-to-end.
 *
 * How it works:
 *   - `fetchJson<T>(url, init)` runs `fetch()` with `cache: "no-store"` so
 *     the browser always asks the backend fresh, checks `res.ok`, and
 *     parses the JSON body as type `T`.
 *   - `api` exports named methods, grouped roughly by feature:
 *       GET  /api/live/status         -> getLiveStatus   (useLiveStatus hook)
 *       GET  /api/live/scene          -> getScene        (useScene hook)
 *       GET  /api/live/events         -> getLiveEvents   (useHistory hook, builds query string)
 *       GET  /api/drift               -> getDrift        (useDrift hook)
 *       GET  /api/admin/health        -> getAdminHealth  (useAdminHealth hook)
 *       GET  /api/tests/status        -> getTestStatus   (useTests hook)
 *       POST /api/tests/run           -> runTests        (useTests hook)
 *       POST /api/feedback            -> sendFeedback    (FeedbackButtons on every EventCard)
 *       POST /chat                    -> chat            (useChat hook -> chat drawer)
 *       GET  /api/watchdog            -> getWatchdogStatus   (useWatchdog / WatchdogContext)
 *       GET  /api/watchdog/recent     -> getWatchdogRecent   (WatchdogPage finding list)
 *       POST /api/watchdog/findings/delete -> deleteWatchdogFindings (bulk delete UI)
 *       DELETE /api/watchdog/findings      -> clearWatchdogFindings  ("Clear all" button)
 *
 * Connects to:
 *   - Backend: endpoints registered in road_safety/server.py and the mount()
 *     helpers in road_safety/api/*.py (feedback, watchdog, tests, etc.).
 *   - UI: imported by every hook under frontend/src/hooks/* (useLiveStatus,
 *     useScene, useDrift, useHistory, useAdminHealth, useTests, useChat,
 *     useWatchdog, WatchdogContext) and by
 *     frontend/src/components/events/FeedbackButtons.tsx.
 */

import type {
  DriftReport,
  HealthData,
  LiveStatus,
  SafetyEvent,
  SceneContext,
  TestStatus,
  WatchdogFinding,
  WatchdogStatus,
} from "../types";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  getLiveStatus: () => fetchJson<LiveStatus>("/api/live/status"),
  getScene: () => fetchJson<SceneContext>("/api/live/scene"),
  getDrift: () => fetchJson<DriftReport>("/api/drift"),
  getAdminHealth: () => fetchJson<HealthData>("/api/admin/health"),
  getTestStatus: () => fetchJson<TestStatus>("/api/tests/status"),
  runTests: () => fetchJson<{ ok: boolean }>("/api/tests/run", { method: "POST" }),

  getLiveEvents: (params?: { risk_level?: string; event_type?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.risk_level) q.set("risk_level", params.risk_level);
    if (params?.event_type) q.set("event_type", params.event_type);
    q.set("limit", String(params?.limit ?? 200));
    return fetchJson<SafetyEvent[]>(`/api/live/events?${q}`);
  },

  sendFeedback: (eventId: string, verdict: "tp" | "fp") =>
    fetchJson<{ status: string }>("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId, verdict }),
    }),

  chat: (query: string) =>
    fetchJson<{ answer: string }>("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),

  getWatchdogStatus: () => fetchJson<WatchdogStatus>("/api/watchdog"),
  getWatchdogRecent: (n = 50) => fetchJson<WatchdogFinding[]>(`/api/watchdog/recent?n=${n}`),

  deleteWatchdogFindings: (keys: string[]) =>
    fetchJson<{ deleted: number }>("/api/watchdog/findings/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }),

  clearWatchdogFindings: () =>
    fetchJson<{ deleted: number }>("/api/watchdog/findings?clear_all=true", {
      method: "DELETE",
    }),
};
