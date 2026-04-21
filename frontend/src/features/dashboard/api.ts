/**
 * Dashboard API surface — scene context, drift report, copilot chat.
 *
 * Keeping the endpoint strings + response types in a single module
 * means components never hit `fetch` directly and refactors are local.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — supports the scene banner, drift banner, and
 *   Copilot chat panel on DashboardPage by wrapping their HTTP endpoints.
 * Backend: GET /api/live/scene, GET /api/drift, POST /chat
 */
import { fetchJson, postJson } from "../../shared/lib/fetchClient";
import type { DriftReport, SceneContext } from "../../shared/types/common";

/**
 * Thin typed wrappers around the dashboard's HTTP endpoints.
 * Each method returns a Promise of the decoded JSON payload.
 *
 * `signal` is the TanStack Query AbortSignal — passing it means the
 * request is cancelled if the caller component unmounts mid-flight.
 */
export const dashboardApi = {
  getScene: (signal?: AbortSignal) => fetchJson<SceneContext>("/api/live/scene", { signal }),
  getDrift: (signal?: AbortSignal) => fetchJson<DriftReport>("/api/drift", { signal }),
  chat: (query: string) => postJson<{ answer: string }>("/chat", { query }),
};

// TEACH: `as const` narrows the literal types so TanStack Query's
// cache-key inference sees `["dashboard", "scene"]` instead of a
// general `string[]`. Prevents accidental key drift.
export const dashboardQueryKeys = {
  scene: ["dashboard", "scene"] as const,
  drift: ["dashboard", "drift"] as const,
};
