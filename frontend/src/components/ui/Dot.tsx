/**
 * Dot.tsx — tiny colored circle used as a status indicator.
 *
 * What it does:
 *   Renders a 7x7 pixel round dot in one of four color variants (ok/bad/wait/default).
 *   The "bad" variant also blinks via CSS animation to draw attention.
 *
 * Purpose:
 *   A reusable visual primitive for showing live/connected/degraded states next
 *   to text labels — e.g., the "live" indicator in the top navigation bar.
 *
 * How it works:
 *   - Props (inputs from the parent component): `variant` picks a color preset,
 *     `style` lets the parent override CSS rules.
 *   - Union type `DotVariant = "ok" | "bad" | "wait" | "default"` means the
 *     variant can only be one of those four strings (TypeScript catches typos).
 *   - The inline `style` object is built by spreading the base size rules, the
 *     variant colors, and any caller override — later keys win.
 *
 * Connects to:
 *   - Backend: none — purely presentational.
 *   - UI: used by `<TopBar>` (inside the connection `<Pill>`) and by
 *     `frontend/src/components/watchdog/WatchdogBadge.tsx`.
 */
// `CSSProperties` is TypeScript's type for React inline-style objects (e.g. { background: "red" }).
import type { CSSProperties } from "react";

// Union type: `variant` must be one of these four exact strings — any other value is a TS error.
type DotVariant = "ok" | "bad" | "wait" | "default";

// Lookup table: variant name -> CSS snippet. `Record<K, V>` means "an object whose keys are K and values are V".
// ok = solid green with a soft glow, bad = red and pulsing via CSS `blink` keyframes,
// wait = amber (connecting), default = muted gray.
const styles: Record<DotVariant, CSSProperties> = {
  ok: { background: "var(--green)", boxShadow: "0 0 6px rgba(34,197,94,.5)" },
  bad: { background: "var(--high)", animation: "blink 1.5s infinite" },
  wait: { background: "var(--medium)" },
  default: { background: "var(--low)" },
};

// Props the parent can pass. The `?` after each name makes it optional.
interface DotProps {
  variant?: DotVariant; // which color preset to use
  style?: CSSProperties; // extra inline CSS to override the base look
}

// Dot — tiny round status indicator (7x7 px circle).
// Lives inside the live-status Pill in the TopBar, and inside the WatchdogBadge.
// `{ variant = "default", style }` destructures props; `= "default"` is the fallback when parent omits it.
export function Dot({ variant = "default", style }: DotProps) {
  return (
    /* Inline <span> rendered as a 7px filled circle.
       The three spreads merge styles in order: base size rules, variant colors, then caller overrides (last wins). */
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%", // 50% on a square = perfect circle
        display: "inline-block",
        ...styles[variant],
        ...style,
      }}
    />
  );
}
