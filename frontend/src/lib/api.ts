/**
 * api.ts — typed fetch helpers for every HTTP endpoint the frontend calls
 * on the FastAPI backend (served on :8000, see CLAUDE.md).
 *
 * Shape of this module:
 *   - One tiny private helper `fetchJson<T>` centralizes request defaults,
 *     error handling, and JSON parsing.
 *   - A single exported object `api` with one method per endpoint. Pages
 *     import `{ api }` and call e.g. `await api.getLiveStatus()`.
 *
 * Why a single object instead of many loose functions? Autocomplete:
 *   `api.` in your editor immediately lists every backend call the
 *   frontend knows how to make. That surface is the contract between
 *   React and the Python server.
 *
 * What is NOT in this file:
 *   - SSE (Server-Sent Events) — the live event stream lives in a
 *     dedicated hook (see `frontend/src/hooks/`), because SSE needs an
 *     EventSource, not `fetch`.
 *   - Auth headers — the frontend is the *public* tier. Privileged
 *     endpoints that need `Authorization: Bearer <ROAD_ADMIN_TOKEN>` or
 *     `X-DSAR-Token` are intentionally not exposed here (see CLAUDE.md
 *     "Auth model"). If you add one, surface auth failures — do not retry
 *     silently (see `.claude/rules/frontend.md`).
 *
 * Consumers: grep `from "../lib/api"` / `from "./lib/api"` to find every
 * page or hook that talks to the backend.
 */

// TEACH: A **type-only import**. The `type` keyword in `import type {...}`
// tells TypeScript that we only need these for type-checking; the bundler
// erases the whole import at build time, so there's zero runtime cost.
// These are the shapes returned by the backend, defined once in
// `frontend/src/types.ts` so backend/frontend stay in sync via codegen
// or hand-written mirrors.
import type {
  DriftReport,
  HealthData,
  LiveSourceStatus,
  LiveSourcesResponse,
  LiveStatus,
  SafetyEvent,
  SceneContext,
  TestStatus,
  WatchdogFinding,
  WatchdogStatus,
} from "../types";

// --- Core helper ---

// TEACH: This is a **generic function**. The `<T>` declares a *type
// parameter* — the caller fills it in at the call site:
//
//     fetchJson<LiveStatus>("/api/live/status")
//
// and TypeScript then knows the return type is `Promise<LiveStatus>`.
// `T` is a placeholder; by convention it's named `T` / `U` / `K`.
//
// `async` makes this function return a `Promise`. Inside the body you can
// use `await` to "pause" until a promise resolves — without `async`, you
// can't use `await`. The return type `Promise<T>` reflects that the
// actual value is produced *eventually*, not synchronously.
//
// `init?: RequestInit` — optional second argument. `RequestInit` is the
// standard TS type for the `fetch()` options object (method, headers,
// body, signal, etc.).
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  // TEACH: `fetch(url, options)` is the browser's built-in HTTP client.
  // It returns a `Promise<Response>`. We `await` it so `res` is the real
  // Response object, not a promise.
  //
  // `{ cache: "no-store", ...init }` — `cache: "no-store"` tells the
  // browser "never serve this from HTTP cache", which we want for
  // real-time safety data. The spread `...init` lets the caller override
  // or add fields (method, headers, body, AbortController signal).
  //
  // AbortController / signal pattern (not used here directly, but worth
  // knowing because you'll see it in hooks):
  //
  //     const ctrl = new AbortController();
  //     api.getX({ signal: ctrl.signal }); // (if exposed)
  //     ctrl.abort();                       // cancels the in-flight fetch
  //
  // It's how React hooks cancel stale requests when a component unmounts
  // or a dependency changes — preventing setState on a dead component.
  const res = await fetch(url, { cache: "no-store", ...init });

  // TEACH: `res.ok` is true for HTTP 2xx. `fetch` does NOT throw on 4xx/5xx
  // by default — you have to check `ok` yourself. We throw a plain Error
  // so callers can catch it in `try { await api.foo() } catch (e) {...}`.
  // The error message carries the status code so the UI can distinguish
  // 401 (auth failure — surface!) from 500 (server bug — watchdog).
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // TEACH: `res.json()` parses the body as JSON and returns another
  // promise. We `await` and then cast the result shape to `T` through the
  // function's return type annotation. There's no runtime validation —
  // we trust the backend contract. If the backend changes shape, you'll
  // see a runtime error down in the component, not here.
  return res.json();
}

// --- Endpoint surface ---

// TEACH: `export const api = { ... }` exports a single object whose keys
// are methods. Each method uses **arrow function** shorthand:
//
//     getLiveStatus: () => fetchJson<LiveStatus>("/api/live/status")
//
// is equivalent to
//
//     getLiveStatus: function() { return fetchJson<LiveStatus>("/api/live/status"); }
//
// Note the method invokes the generic: `fetchJson<LiveStatus>(...)` — the
// `<LiveStatus>` tells TS that this call produces a `Promise<LiveStatus>`.
// Without it, TS would infer `Promise<unknown>` and callers would have to
// cast everywhere.
export const api = {
  // Live perception status (is the stream running? current scene? fps?).
  getLiveStatus: () => fetchJson<LiveStatus>("/api/live/status"),
  // Scene context classifier output (urban/highway/parking + thresholds).
  getScene: () => fetchJson<SceneContext>("/api/live/scene"),
  // Model drift summary for the detection stack.
  getDrift: () => fetchJson<DriftReport>("/api/drift"),
  // Admin health panel (NOTE: this is a *public-tier* health view; the
  // sensitive admin endpoints require Bearer auth and are not here).
  getAdminHealth: () => fetchJson<HealthData>("/api/admin/health"),
  // Test runner current state (idle/running/pass/fail + last output).
  getTestStatus: () => fetchJson<TestStatus>("/api/tests/status"),
  // Kick off a test run. `{ method: "POST" }` is passed via the `init`
  // arg of fetchJson — no body needed. Returns `{ ok: boolean }`.
  runTests: () => fetchJson<{ ok: boolean }>("/api/tests/run", { method: "POST" }),

  // TEACH: `params?: { risk_level?: string; ... }` — an **inline object
  // type** (anonymous interface). All fields are optional. The whole
  // `params` object is also optional, so `api.getLiveEvents()` with zero
  // args is valid.
  getLiveEvents: (params?: { risk_level?: string; event_type?: string; limit?: number }) => {
    // TEACH: `URLSearchParams` is the standard way to build a querystring
    // safely (handles encoding of `&`, spaces, etc.). You .set() keys then
    // coerce to string via template literal or `.toString()`.
    const q = new URLSearchParams();
    // TEACH: Optional chaining `params?.risk_level` — returns `undefined`
    // if `params` is null/undefined, instead of crashing. Paired with
    // an `if` it only adds the key when the caller supplied a value.
    if (params?.risk_level) q.set("risk_level", params.risk_level);
    if (params?.event_type) q.set("event_type", params.event_type);
    // TEACH: `params?.limit ?? 200` — **nullish coalescing** (`??`) means
    // "if left is null/undefined use the right". Unlike `||`, zero and
    // empty string are NOT replaced — though here `limit` is a number so
    // `||` would be fine too.
    q.set("limit", String(params?.limit ?? 200));
    return fetchJson<SafetyEvent[]>(`/api/live/events?${q}`);
  },

  // TEACH: A POST with a JSON body. Notice the pattern for every mutation:
  //   1. `method: "POST"`
  //   2. `headers: { "Content-Type": "application/json" }` so FastAPI
  //      parses it as JSON (otherwise it will reject or pass raw bytes).
  //   3. `body: JSON.stringify({...})` — fetch accepts strings or blobs;
  //      for JSON APIs you always stringify.
  // Types: `eventId: string` (UUID from an event), `verdict: "tp" | "fp"`
  // (a **union of string literals** — "true positive" or "false positive").
  // Anywhere else the call-site writes `api.sendFeedback(id, "maybe")`,
  // TS will reject it at compile time.
  sendFeedback: (eventId: string, verdict: "tp" | "fp") =>
    fetchJson<{ status: string }>("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId, verdict }),
    }),

  // TEACH: Calls the `/chat` endpoint (LLM-backed Q&A). Note: no `/api`
  // prefix here — the backend mounts it at the root. If you're confused
  // about which path is which, check `road_safety/server.py` route list.
  chat: (query: string) =>
    fetchJson<{ answer: string }>("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),

  // --- Watchdog endpoints (incident queue, see CLAUDE.md) ---
  //
  // NOTE: Only the *read* watchdog endpoints live here. The two destructive
  // routes (`POST /api/watchdog/findings/delete` and `DELETE
  // /api/watchdog/findings`) require admin Bearer auth (see Settings Console
  // S0 prereq hardening) and are therefore wired directly through
  // `lib/adminApi.ts` from the consumer hooks (see hooks/WatchdogContext.tsx).

  // Summary status for the watchdog incident queue.
  getWatchdogStatus: () => fetchJson<WatchdogStatus>("/api/watchdog"),
  // TEACH: Default parameter value `n = 50`. If the caller invokes
  // `api.getWatchdogRecent()` with no argument, `n` is 50.
  getWatchdogRecent: (n = 50) => fetchJson<WatchdogFinding[]>(`/api/watchdog/recent?n=${n}`),

  // --- Multi-source perception lifecycle ---
  // List every configured perception source with running status.
  getLiveSources: () => fetchJson<LiveSourcesResponse>("/api/live/sources"),
  // Resume capture on a paused source.
  startLiveSource: (id: string) =>
    fetchJson<LiveSourceStatus>(`/api/live/sources/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),
  // Pause a running source (slot is preserved for restart).
  pauseLiveSource: (id: string) =>
    fetchJson<LiveSourceStatus>(`/api/live/sources/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    }),
};
