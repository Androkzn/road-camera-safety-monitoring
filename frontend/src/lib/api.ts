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
};
