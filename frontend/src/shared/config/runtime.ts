/**
 * Runtime constants used across hooks/components.
 *
 * Centralising timing, stale windows and buffer limits avoids "magic number"
 * drift across features and makes future tuning one-file.
 *
 * --- UI mapping ---
 * Used on: All pages (utility — no UI of its own). Imported by polling
 *   hooks, SSE backoff, the live-tile retry loop, and other timing knobs
 *   on every page.
 * UI element: no element — pure constants (poll intervals, stale times,
 *   buffer limits, thresholds) consumed by hooks and components.
 */
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
  streamImageFrame: 400,
  streamTileRetry: 1_500,
  eventCardFlash: 1_500,
  detectionsFpsWindow: 3_000,
  uptimeTicker: 1_000,
} as const;

export const DELAY_MS = {
  monitoringLastVisit: 4_000,
} as const;

export const SSE_BACKOFF = {
  initialMs: 2_000,
  multiplier: 1.5,
  maxMs: 30_000,
} as const;

export const STALE_TIME_MS = {
  liveSources: 2_000,
  validator: 2_000,
  watchdog: 10_000,
  tests: 1_000,
} as const;

export const LIMITS = {
  eventStreamBuffer: 100,
  detectionsFrames: 8,
  watchdogRecent: 100,
  liveEventsDefaultLimit: 200,
} as const;

export const THRESHOLDS = {
  ttcWarnSec: 1.5,
  defaultWatchdogIntervalSec: 60,
  clipWindowSec: 3,
} as const;
