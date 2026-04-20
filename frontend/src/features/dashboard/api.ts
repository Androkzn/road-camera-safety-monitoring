/**
 * Dashboard API surface — scene context, drift report, copilot chat.
 */
import { fetchJson, postJson } from "../../shared/lib/fetchClient";
import type { DriftReport, SceneContext } from "../../shared/types/common";

export const dashboardApi = {
  getScene: (signal?: AbortSignal) =>
    fetchJson<SceneContext>("/api/live/scene", { signal }),
  getDrift: (signal?: AbortSignal) =>
    fetchJson<DriftReport>("/api/drift", { signal }),
  chat: (query: string) => postJson<{ answer: string }>("/chat", { query }),
};

export const dashboardQueryKeys = {
  scene: ["dashboard", "scene"] as const,
  drift: ["dashboard", "drift"] as const,
};
