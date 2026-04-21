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

const base: CSSProperties = {
  display: "inline-block",
  padding: "2px 7px",
  borderRadius: 4,
  fontSize: "10.5px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const colors: Record<string, CSSProperties> = {
  high: { background: "var(--high)", color: "#fff" },
  medium: { background: "var(--medium)", color: "#111" },
  low: { background: "var(--low)", color: "#fff" },
};

interface RiskBadgeProps {
  level: string;
  compact?: boolean;
}

export function RiskBadge({ level, compact }: RiskBadgeProps) {
  const lower = level.toLowerCase();
  const sizeOverride: CSSProperties = compact
    ? { padding: "1px 6px", fontSize: "9.5px", letterSpacing: "0.4px" }
    : {};
  return (
    <span style={{ ...base, ...(colors[lower] ?? colors.low), ...sizeOverride }}>{lower}</span>
  );
}
