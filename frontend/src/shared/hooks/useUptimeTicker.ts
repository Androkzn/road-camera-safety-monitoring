/**
 * useUptimeTicker — seconds-granularity re-render trigger for "live
 * uptime" / "X seconds ago" labels.
 *
 * No network I/O — pure client-side clock math against a supplied boot
 * timestamp. Monotonically increases as long as the browser clock
 * advances. Downstream consumers: stream headers, impact cards, and
 * dashboard widgets that display elapsed time since a known start.
 *
 * Replaces the 4 duplicated `setInterval(…, 1000)` blocks identified in
 * the frontend audit (AdminPage:86, DashboardPage:102,
 * SelectedStreamHeader:55, ImpactCard:36). Each of those sites spins up
 * its own one-second heartbeat to keep an elapsed counter fresh; this
 * hook centralises that pattern.
 *
 * Pass `startedAt` as either a unix-seconds number or an ISO-ish string
 * the platform can parse. When it is `null` / `undefined`, the hook
 * returns `0` and installs no interval — so call sites can safely use
 * it unconditionally even before their upstream data has loaded.
 *
 * --- UI mapping ---
 * Used on: AdminPage, DashboardPage, MonitoringPage, SettingsPage —
 *   anywhere a live "uptime" / "X seconds ago" label needs to tick.
 * UI element: no element on its own — drives the live elapsed-seconds
 *   counters in stream headers, impact cards and dashboard widgets.
 */
import { useEffect, useState } from "react";

import { POLL_INTERVAL_MS } from "../config/runtime";

// Normalise the accepted input shapes to unix-seconds (or null when
// the value is missing or unparseable). Numbers are assumed to already be
// unix-seconds; strings go through Date.parse (ISO-8601 etc.) and are
// converted from ms to seconds.
function toEpochSec(startedAt: string | number | null | undefined): number | null {
  if (startedAt === null || startedAt === undefined) return null;
  if (typeof startedAt === "number") {
    return Number.isFinite(startedAt) ? startedAt : null;
  }
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

/**
 * useUptimeTicker — returns whole seconds elapsed since `startedAt`,
 * re-rendering on every tick.
 *
 * Params:
 *   - startedAt: unix-seconds number OR parseable date string OR null/undefined
 *     (common while upstream data is still loading).
 *   - intervalMs: tick cadence, default POLL_INTERVAL_MS.uptimeTicker (1s).
 *
 * Returns: non-negative integer of elapsed seconds. Returns 0 when
 *   `startedAt` is null/undefined/unparseable (and installs no interval).
 *
 * Side effects: installs a window.setInterval on mount (when startedAt
 *   resolves) and clears it on unmount / dep change, so no stray timers
 *   leak when the start time changes.
 */
export function useUptimeTicker(
  startedAt: string | number | null | undefined,
  intervalMs: number = POLL_INTERVAL_MS.uptimeTicker,
): number {
  const epoch = toEpochSec(startedAt);
  // Lazy initial state: compute elapsed once on mount so the first paint
  // already shows a realistic value instead of "0" for one tick.
  const [elapsed, setElapsed] = useState<number>(() =>
    epoch === null ? 0 : Math.max(0, Math.floor(Date.now() / 1000 - epoch)),
  );

  useEffect(() => {
    if (epoch === null) {
      // No valid start time — reset to 0 and skip installing an interval.
      setElapsed(0);
      return;
    }
    // Floor + clamp at 0 guards against clock skew where Date.now() is
    // briefly earlier than the provided start (would otherwise flash negative).
    const tick = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000 - epoch)));
    tick();
    const id = window.setInterval(tick, intervalMs);
    // Cleanup: clearInterval on unmount / epoch change / intervalMs change
    // — otherwise a changed start time would leave the old timer running.
    return () => window.clearInterval(id);
  }, [epoch, intervalMs]);

  return elapsed;
}
