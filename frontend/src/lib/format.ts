/**
 * format.ts — small presentation helpers shared across the dashboard UI.
 *
 * What it does:
 *   Exports pure string formatters that turn raw backend values (timestamps,
 *   uptime seconds, confidence floats, thumbnail paths, snake_case event
 *   types) into human-friendly display strings. No React, no state — just
 *   input -> string.
 *
 * Purpose:
 *   Gives every card/tile a consistent look (e.g. all confidences show as
 *   "82%", all times show as "HH:MM:SS") and one place to tweak rules.
 *   Using "—" as a fallback keeps cells from collapsing when data is absent.
 *
 * How it works:
 *   - `formatWallTime(ts)`: parses an ISO string / millisecond number with
 *     `new Date()` and renders "HH:MM:SS". Returns "—" if the date is
 *     invalid (NaN check).
 *   - `humanEventType(t)`: replaces underscores with spaces and uppercases
 *     the first letter (e.g. `pedestrian_proximity` -> `Pedestrian proximity`).
 *   - `formatUptime(secs)`: splits seconds into h/m/s; uses `padStart` via
 *     the `pad2` helper so minutes/seconds always show two digits.
 *   - `formatConfidence(c)`: multiplies a 0-1 float by 100 and rounds to a
 *     percent string.
 *   - `normalizeThumbnail(thumb)`: ensures thumbnail paths are either
 *     absolute URLs or root-relative ("/thumbnails/..."). Prepends "/" when
 *     the path is bare so the browser hits the FastAPI static mount.
 *   The `?` in parameter types (e.g. `ts?: string | number`) means "optional"
 *   — callers may pass `undefined`, and each helper returns "—" in that case.
 *
 * Connects to:
 *   - Backend: none — pure UI. Values come from api.ts responses such as
 *     LiveStatus.uptime_seconds or SafetyEvent.thumbnail.
 *   - UI: imported by frontend/src/pages/DashboardPage.tsx,
 *     frontend/src/pages/AdminPage.tsx,
 *     frontend/src/components/events/EventCard.tsx,
 *     frontend/src/components/events/AdminEventCard.tsx, and
 *     frontend/src/components/dashboard/SummaryTiles.tsx.
 */

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function formatWallTime(ts?: string | number): string {
  const d = ts ? new Date(ts) : new Date();
  if (isNaN(d.getTime())) return "—";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function humanEventType(t?: string): string {
  return (t || "event")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function formatUptime(secs?: number | null): string {
  if (secs == null || secs < 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${pad2(m)}m` : `${pad2(m)}:${pad2(s)}`;
}

export function formatConfidence(c?: number | null): string {
  return c != null ? `${Math.round(c * 100)}%` : "—";
}

export function normalizeThumbnail(thumb?: string): string {
  if (!thumb) return "";
  if (/^https?:/.test(thumb) || thumb.startsWith("/")) return thumb;
  return "/" + thumb;
}
