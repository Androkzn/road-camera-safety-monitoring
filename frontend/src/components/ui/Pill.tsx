/**
 * Pill.tsx — rounded capsule container for inline status text.
 *
 * What it does:
 *   Renders a dark, rounded "pill" shape that wraps its children (usually a
 *   `<Dot>` plus a short label). No interactivity — it's a layout wrapper.
 *
 * Purpose:
 *   Provides the signature capsule look used in the top navigation bar for
 *   status snippets like "dashcam_1 • live" or "uptime 2h 14m".
 *
 * How it works:
 *   - Props: `children` (the content inside — ReactNode means any renderable
 *     value, e.g. text, another component, a fragment) and optional `style`
 *     for caller overrides.
 *   - The base CSS object is spread first, then caller overrides, so the
 *     caller always wins when keys overlap.
 *
 * Connects to:
 *   - Backend: none — purely presentational.
 *   - UI: used by `layout/TopBar.tsx` (live-status pill) and
 *     `pages/AdminPage.tsx` (uptime pill injected via TopBar's children slot).
 */
// `ReactNode` = any renderable content; `CSSProperties` = React inline-style object.
import type { CSSProperties, ReactNode } from "react";

// Base capsule look: flex row, rounded ends (borderRadius 999 forces pill shape),
// dark panel bg, thin border, tiny muted text. Children render horizontally with a 6 px gap.
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

// Props: `children` is anything between <Pill>…</Pill> (usually a <Dot/> + label text).
// `style` lets callers tweak the look per instance.
interface PillProps {
  children: ReactNode;
  style?: CSSProperties;
}

// Pill — rounded dark capsule used in the TopBar for live-status text like "dashcam_1 • live".
// Also used on the Admin page to show uptime. No interaction; pure layout wrapper.
export function Pill({ children, style }: PillProps) {
  /* Single <span> styled as a pill; spreads base first, caller overrides last so parent always wins. */
  return <span style={{ ...base, ...style }}>{children}</span>;
}
