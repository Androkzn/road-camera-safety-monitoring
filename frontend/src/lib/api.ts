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

// `import type { ... }` — types are erased at build time, so this import adds
// zero runtime cost. These describe the JSON shapes the backend returns.
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

// fetchJson<T> — shared HTTP helper used by every method below.
// Generic `<T>`: the caller names the expected response type; TypeScript then
// treats the returned Promise as Promise<T>.
// `fetch(url, init)` is the browser API to make HTTP requests; returns a Promise<Response>.
// `cache: "no-store"` disables HTTP caching so dashboards always see fresh data.
// `res.ok` is true for 2xx status codes. `.json()` parses the body as JSON (Promise).
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// `api` — single frozen-ish object grouping every backend call. Each method
// is an arrow function so `fetchJson` isn't invoked until the method is called.
export const api = {
  // getLiveStatus — GET /api/live/status
  // Called from: hooks/useLiveStatus -> StatusBar and SummaryTiles on Dashboard.
  // Returns: LiveStatus { uptime_seconds, events_count, ... }.
  getLiveStatus: () => fetchJson<LiveStatus>("/api/live/status"),

  // getScene — GET /api/live/scene
  // Called from: hooks/useScene -> CopilotPanel scene description block.
  // Returns: SceneContext { location, weather, road_type, ... }.
  getScene: () => fetchJson<SceneContext>("/api/live/scene"),

  // getDrift — GET /api/drift
  // Called from: hooks/useDrift -> DriftBanner at top of Dashboard.
  // Returns: DriftReport { precision, delta, window, ... }.
  getDrift: () => fetchJson<DriftReport>("/api/drift"),

  // getAdminHealth — GET /api/admin/health
  // Called from: hooks/useAdminHealth -> HealthPanel on AdminPage.
  // Returns: HealthData { cpu, memory, queues, ... }.
  getAdminHealth: () => fetchJson<HealthData>("/api/admin/health"),

  // getTestStatus — GET /api/tests/status
  // Called from: hooks/useTests -> TestsPanel on AdminPage.
  // Returns: TestStatus { running, last_run, results, ... }.
  getTestStatus: () => fetchJson<TestStatus>("/api/tests/status"),

  // runTests — POST /api/tests/run
  // Called from: hooks/useTests -> "Run tests" button on AdminPage.
  // Returns: { ok: boolean } (kickoff acknowledgment).
  runTests: () => fetchJson<{ ok: boolean }>("/api/tests/run", { method: "POST" }),

  // getLiveEvents — GET /api/live/events?[risk_level=&event_type=&limit=]
  // Called from: hooks/useHistory -> HistoryPanel on AdminPage.
  // Builds a query string with URLSearchParams; `??` uses 200 only if limit is null/undefined.
  // Returns: SafetyEvent[] (recent events matching filters).
  getLiveEvents: (params?: { risk_level?: string; event_type?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.risk_level) q.set("risk_level", params.risk_level);
    if (params?.event_type) q.set("event_type", params.event_type);
    q.set("limit", String(params?.limit ?? 200));
    return fetchJson<SafetyEvent[]>(`/api/live/events?${q}`);
  },

  // sendFeedback — POST /api/feedback { event_id, verdict }
  // Called from: components/events/FeedbackButtons (every EventCard on Dashboard).
  // Returns: { status: string } (e.g. "stored").
  sendFeedback: (eventId: string, verdict: "tp" | "fp") =>
    fetchJson<{ status: string }>("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId, verdict }),
    }),

  // chat — POST /chat { query }
  // Called from: hooks/useChat -> the copilot chat drawer.
  // Returns: { answer: string } (LLM response text).
  chat: (query: string) =>
    fetchJson<{ answer: string }>("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),

  // getWatchdogStatus — GET /api/watchdog
  // Called from: hooks/useWatchdog and WatchdogContext -> WatchdogBanner/Page.
  // Returns: WatchdogStatus { healthy, findings_count, last_run, ... }.
  getWatchdogStatus: () => fetchJson<WatchdogStatus>("/api/watchdog"),

  // getWatchdogRecent — GET /api/watchdog/recent?n=<n>
  // Called from: WatchdogPage finding list (default shows 50 most recent).
  // Returns: WatchdogFinding[] ordered newest-first.
  getWatchdogRecent: (n = 50) => fetchJson<WatchdogFinding[]>(`/api/watchdog/recent?n=${n}`),

  // deleteWatchdogFindings — POST /api/watchdog/findings/delete { keys }
  // Called from: bulk-delete action on WatchdogPage (checkbox + "Delete selected").
  // Returns: { deleted: number } count of rows removed.
  deleteWatchdogFindings: (keys: string[]) =>
    fetchJson<{ deleted: number }>("/api/watchdog/findings/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }),

  // clearWatchdogFindings — DELETE /api/watchdog/findings?clear_all=true
  // Called from: "Clear all" button on WatchdogPage.
  // Returns: { deleted: number } total rows wiped.
  clearWatchdogFindings: () =>
    fetchJson<{ deleted: number }>("/api/watchdog/findings?clear_all=true", {
      method: "DELETE",
    }),
};
