/**
 * Pill — rounded "capsule" container, typically holding a Dot + label
 * for status strips (e.g. <Pill><Dot variant="ok" /> LIVE</Pill>).
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Most prominent in the TopBar
 *   live-connection indicator that is visible on every page.
 * UI element: rounded pill chip — typically wraps a Dot plus a short
 *   text label to form a status badge.
 */
import type { CSSProperties, ReactNode } from "react";

// Base style — inline-flex keeps the Dot and label on a single baseline;
// `borderRadius: 999` is the standard "fully rounded capsule" trick
// (any value larger than half the height collapses to a pill).
// Colours use theme CSS vars so dark/light tokens stay consistent.
const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 9px",
  borderRadius: 999,
  background: "#0b0f14",
  border: "1px solid var(--border)",
  fontSize: "11px",
  color: "var(--muted)",
};

// Children is typically a <Dot /> + text label, but any ReactNode works.
// `style` is merged on top of `base` so callers can override individual
// tokens (e.g. a warning-coloured border) without forking the component.
interface PillProps {
  children: ReactNode;
  style?: CSSProperties;
}

/**
 * Renders a rounded capsule <span>. No variants — consumers style the
 * contents (e.g. coloured Dot, text weight) rather than the Pill itself.
 */
export function Pill({ children, style }: PillProps) {
  // Spread order matters: caller `style` wins over `base` tokens.
  return <span style={{ ...base, ...style }}>{children}</span>;
}
