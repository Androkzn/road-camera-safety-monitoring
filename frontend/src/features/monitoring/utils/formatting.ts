/**
 * Tiny display-formatting helpers used only by the monitoring feature.
 *
 * Pure functions — no React, no DOM, no side effects. Easy to unit-test.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: No direct UI — formats the "first seen" / "last seen"
 *   timestamps and the small severity glyph shown on each incident card
 *   in the feed and on the Immediate Actions tiles.
 */

/**
 * Format an ISO timestamp into "Apr 20, 3:42 PM"-style locale text.
 * Falls back to the raw string if parsing fails (defensive — the watchdog
 * backend should never send malformed timestamps, but we won't crash if it does).
 */
export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format a timestamp as a coarse "Ns/m/h/d ago" string. Clamps at 0 to
 * avoid "−3s ago" if clocks drift. Steps up the unit at each 60/60/24 threshold.
 */
export function formatRelative(ts: string): string {
  const target = new Date(ts).getTime();
  if (Number.isNaN(target)) return ts;
  const diffSec = Math.max(0, Math.round((Date.now() - target) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

/** Severity → short glyph shown in the card header. */
export const SEV_ICON: Record<string, string> = {
  error: "!!",
  warning: "!",
  info: "i",
};
