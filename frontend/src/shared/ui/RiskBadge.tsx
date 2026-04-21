/**
 * RiskBadge — uppercase coloured badge for an event's risk level.
 * Colour tokens (`--high`, `--medium`, `--low`) match the conflict-gate
 * thresholds the backend uses (see CLAUDE.md).
 *
 * --- UI mapping ---
 * Used on: DashboardPage, AdminPage, MonitoringPage — anywhere a safety
 *   event is rendered (EventCard, EventDialog, monitoring incident rows).
 * UI element: small uppercase coloured badge ("HIGH", "MEDIUM", "LOW")
 *   shown next to event titles to signal severity at a glance.
 */
import type { CSSProperties } from "react";

// Shared visual shell — the uppercase+letter-spacing combo is what
// gives every badge its "status label" feel regardless of colour.
const base: CSSProperties = {
  display: "inline-block",
  padding: "2px 7px",
  borderRadius: 4,
  fontSize: "10.5px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

// Severity -> theme colour mapping. Background tokens are defined in
// the global theme so a11y-tuned contrast is preserved across dark/
// light modes. Text colour is hand-picked per background: `medium`
// uses dark text because the amber background is too bright for white.
const colors: Record<string, CSSProperties> = {
  high: { background: "var(--high)", color: "#fff" },
  medium: { background: "var(--medium)", color: "#111" },
  low: { background: "var(--low)", color: "#fff" },
};

// `level` comes straight from `SafetyEvent.risk_level` ("high"/"medium"/
// "low"). Kept as a plain string (not a union) because the backend may
// introduce new tiers before the TS type regenerates — in that case we
// fall back to the low-risk style below.
// `compact` shrinks the badge for dense contexts (e.g. monitoring rows).
interface RiskBadgeProps {
  level: string;
  compact?: boolean;
}

/**
 * Renders a single coloured severity badge (HIGH / MEDIUM / LOW).
 * Purely presentational; no interactivity. Unknown levels degrade to
 * the `low` palette so an unexpected backend value never crashes.
 */
export function RiskBadge({ level, compact }: RiskBadgeProps) {
  // Normalise to lowercase because the backend has historically emitted
  // mixed casing for this field; this keeps the lookup resilient.
  const lower = level.toLowerCase();
  // Compact mode tightens padding + typography without touching colours.
  const sizeOverride: CSSProperties = compact
    ? { padding: "1px 6px", fontSize: "9.5px", letterSpacing: "0.4px" }
    : {};
  // `colors[lower] ?? colors.low` — unknown/new severity labels fall
  // back to the low palette rather than rendering an unstyled span.
  return (
    <span style={{ ...base, ...(colors[lower] ?? colors.low), ...sizeOverride }}>{lower}</span>
  );
}
