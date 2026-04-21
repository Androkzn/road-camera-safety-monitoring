/**
 * Runtime constants used across hooks/components.
 *
 * Centralising timing, stale windows and buffer limits avoids "magic number"
 * drift across features and makes future tuning one-file.
 *
 * Scope: build-time constants only — no env-var reads live here.
 *
 * Downstream consumers: polling hooks (useLiveStatus, useUptimeTicker,
 * useLiveSources, …), the SSE reconnect loop in useSSE, the admin live-tile
 * retry loop, React Query staleTime settings, and event-buffer caps.
 *
 * --- UI mapping ---
 * Used on: All pages (utility — no UI of its own). Imported by polling
 *   hooks, SSE backoff, the live-tile retry loop, and other timing knobs
 *   on every page.
 * UI element: no element — pure constants (poll intervals, stale times,
 *   buffer limits, thresholds) consumed by hooks and components.
 */

// Poll cadences (ms) for React-Query `refetchInterval` and a few
// hand-rolled timers (streamImageFrame, uptimeTicker).
// The `...Settings` variants are slower cadences used on the settings
// page where a fresher feed isn't worth the request cost.
export const POLL_INTERVAL_MS = {
  liveStatus: 5_000,
  liveStatusSettings: 15_000,
  adminHealth: 4_000,
  liveSources: 5_000,
  liveSourcesSettings: 15_000,
  settingsEffective: 15_000,
  settingsImpact: 5_000,
  dashboardScene: 7_000,
  dashboardDrift: 30_000,
  validator: 5_000,
  watchdog: 15_000,
  testsRunning: 1_500,
  testsIdle: 10_000,
  // streamImageFrame: poll cadence for /admin/frame/{id}. Matches the
  // pipeline's 2 fps inference rate — one poll per produced frame.
  streamImageFrame: 400,
  streamTileRetry: 1_500,
  eventCardFlash: 1_500,
  detectionsFpsWindow: 3_000,
  // uptimeTicker: default cadence for useUptimeTicker (seconds granularity).
  uptimeTicker: 1_000,
} as const;

// One-shot delays (ms) — not recurring. e.g. how long after landing on
// MonitoringPage before we bump the "last visited" timestamp.
export const DELAY_MS = {
  monitoringLastVisit: 4_000,
} as const;

// Reconnect backoff for the SSE client in useSSE.
// Delay starts at `initialMs`, grows by `multiplier` on each failure,
// and caps at `maxMs`. Reset to `initialMs` on a successful `onopen`.
export const SSE_BACKOFF = {
  initialMs: 2_000,
  multiplier: 1.5,
  maxMs: 30_000,
} as const;

// React Query `staleTime` per feature — how long cached data is treated
// as fresh (no refetch-on-mount) before background revalidation kicks in.
export const STALE_TIME_MS = {
  liveSources: 2_000,
  validator: 2_000,
  watchdog: 10_000,
  tests: 1_000,
} as const;

// Bounded in-memory buffers — keep these small: SSE is a firehose and
// unbounded arrays would leak memory over long sessions.
export const LIMITS = {
  eventStreamBuffer: 100, // max SafetyEvents retained in EventStreamProvider
  detectionsFrames: 8, // admin detection-rate sliding window
  watchdogRecent: 100, // recent watchdog findings shown in the queue
  liveEventsDefaultLimit: 200, // initial /api/events fetch size
} as const;

// Domain thresholds surfaced in the UI.
// ttcWarnSec: below this time-to-collision we flag the event visually.
// defaultWatchdogIntervalSec: fallback cadence when the server doesn't send one.
// clipWindowSec: seconds of pre/post context requested when rendering a clip.
export const THRESHOLDS = {
  ttcWarnSec: 1.5,
  defaultWatchdogIntervalSec: 60,
  clipWindowSec: 3,
} as const;
