/**
 * RiskBadge.tsx — colored pill that labels an event's risk level.
 *
 * What it does:
 *   Renders the uppercase risk text ("HIGH", "MEDIUM", "LOW") inside a solid
 *   color box — red for high, amber for medium, gray for low. A `compact`
 *   mode shrinks it for dense lists (e.g., the admin history panel).
 *
 * Purpose:
 *   Gives every event card the same at-a-glance severity swatch so operators
 *   can triage the event stream quickly.
 *
 * How it works:
 *   - Props: `level` (string from the backend like "high"), and optional
 *     `compact` flag. The level is lower-cased so casing from the API does
 *     not matter.
 *   - The `colors[lowerLevel] ?? colors.low` pattern is a fallback: if the
 *     level is unknown, it falls back to the low style.
 *   - Style objects are merged via spread — base rules, color variant, and
 *     optional compact size overrides — later keys win.
 *
 * Connects to:
 *   - Backend: reads `SafetyEvent.risk_level` returned from `/api/live/events`
 *     and the live SSE stream — but does not fetch anything itself.
 *   - UI: used by `events/EventCard.tsx` and `events/AdminEventCard.tsx`.
 */
// `CSSProperties` = React inline-style object type.
import type { CSSProperties } from "react";

// Shared layout for every badge: small solid block, bold uppercase text, slight letter spacing.
const base: CSSProperties = {
  display: "inline-block",
  padding: "2px 7px",
  borderRadius: 4,
  fontSize: "10.5px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

// Color map keyed by level. high = solid red with white text, medium = amber with dark text,
// low = gray with white text. Any unknown level falls back to `low` below.
const colors: Record<string, CSSProperties> = {
  high: { background: "var(--high)", color: "#fff" },
  medium: { background: "var(--medium)", color: "#111" },
  low: { background: "var(--low)", color: "#fff" },
};

// Props: `level` is the risk string from the backend; `compact` shrinks padding/font for dense lists.
interface RiskBadgeProps {
  level: string;
  compact?: boolean;
}

// RiskBadge — colored severity chip rendered on every EventCard (e.g. "HIGH", "MEDIUM", "LOW").
// Sits in the header row of an event, next to the timestamp.
export function RiskBadge({ level, compact }: RiskBadgeProps) {
  // Normalize casing so "High", "HIGH", "high" all match the colors lookup.
  const lowerLevel = level.toLowerCase();
  // Ternary: when `compact` is true, use smaller padding/font; otherwise empty override (no change).
  const sizeOverride: CSSProperties = compact
    ? { padding: "1px 6px", fontSize: "9.5px", letterSpacing: "0.4px" }
    : {};

  /* Single <span> chip. `colors[lowerLevel] ?? colors.low` = nullish coalescing:
     if no color matches the level, fall back to the low-risk style. */
  return (
    <span style={{ ...base, ...(colors[lowerLevel] ?? colors.low), ...sizeOverride }}>
      {lowerLevel}
    </span>
  );
}
