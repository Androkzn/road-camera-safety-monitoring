/**
 * Pill — a rounded "capsule" container, typically used for top-level
 * status strips at the top of pages ("LIVE", "42 events/min", "camera: ok").
 *
 * Visual role: larger and more prominent than <Tag>. The border-radius of
 * 999px forces the short ends to be perfectly round — the classic "pill"
 * shape. Uses `inline-flex` with a 6px gap so callers can drop a <Dot>
 * and some text inside and get auto-aligned spacing:
 *
 *   <Pill><Dot variant="ok" /> LIVE</Pill>
 *
 * Exports: `Pill`. Consumers: grep `<Pill ` across `frontend/src/pages/`
 * and components.
 *
 * Styling: inline styles (tiny primitive; see Dot.tsx header).
 */

// TEACH: Same React type imports as Tag.tsx — type-only, erased at build.
import type { CSSProperties, ReactNode } from "react";

// --- Styles ---

// TEACH: `inline-flex` = an inline element that uses flexbox for its
// children. `alignItems: "center"` vertically centers them; `gap: 6` puts
// 6px between each child (so a Dot + label auto-space). `borderRadius:
// 999` is the standard "give me a pill/capsule" trick — any number
// greater than half the height rounds the short ends fully.
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

// --- Props ---

// TEACH: Minimal API on purpose — `children` is required (a Pill with
// nothing inside is meaningless) and `style` is an escape hatch for
// one-off tweaks. There's no `variant` here because callers typically
// compose colour by nesting a <Dot> rather than restyling the Pill.
interface PillProps {
  children: ReactNode;
  style?: CSSProperties;
}

// --- Component ---

// TEACH: When a component body is a single JSX expression, you can skip
// the `return (` block and use an implicit-return arrow... but here we
// use the standard `function` form + explicit `return`. Either works.
// `...base` first, `...style` last so caller overrides win.
export function Pill({ children, style }: PillProps) {
  return <span style={{ ...base, ...style }}>{children}</span>;
}
