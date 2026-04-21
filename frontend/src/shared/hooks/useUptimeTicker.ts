/**
 * useUptimeTicker — seconds-granularity re-render trigger for "live
 * uptime" / "X seconds ago" labels.
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

function toEpochSec(startedAt: string | number | null | undefined): number | null {
  if (startedAt === null || startedAt === undefined) return null;
  if (typeof startedAt === "number") {
    return Number.isFinite(startedAt) ? startedAt : null;
  }
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

export function useUptimeTicker(
  startedAt: string | number | null | undefined,
  intervalMs: number = POLL_INTERVAL_MS.uptimeTicker,
): number {
  const epoch = toEpochSec(startedAt);
  const [elapsed, setElapsed] = useState<number>(() =>
    epoch === null ? 0 : Math.max(0, Math.floor(Date.now() / 1000 - epoch)),
  );

  useEffect(() => {
    if (epoch === null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000 - epoch)));
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [epoch, intervalMs]);

  return elapsed;
}
