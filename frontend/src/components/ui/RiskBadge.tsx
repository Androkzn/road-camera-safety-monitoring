/**
 * RiskBadge — uppercase coloured badge displaying an event's risk level.
 *
 * Visual role: the single most eye-catching atom in the UI. Renders one
 * of "HIGH" / "MEDIUM" / "LOW" in colour-coded, uppercase, bold letters.
 * Used in event rows, incident cards, and anywhere a risk level needs to
 * be surfaced at a glance.
 *
 * Props:
 *   - `level`  string from the backend (e.g. "HIGH", "high", "Medium") —
 *              lowercased before lookup so casing on the wire doesn't
 *              matter.
 *   - `compact` when true, renders a tighter version for dense tables.
 *
 * Exports: `RiskBadge`. Consumers: grep `<RiskBadge ` across pages.
 *
 * Styling: inline styles (tiny primitive; see Dot.tsx header).
 *
 * Note: the colour tokens (`var(--high)` etc.) match the conflict-gate
 * thresholds from the backend (see `road_safety/core/` in CLAUDE.md).
 */

// TEACH: Only `CSSProperties` is needed here — no `ReactNode` because
// this component has no `children` prop; it renders its own text.
import type { CSSProperties } from "react";

// --- Styles ---

// TEACH: Shared visual skeleton, same pattern as Tag.tsx.
// `textTransform: "uppercase"` means the caller can pass `"high"` and we
// still display `HIGH` — no manual `.toUpperCase()` needed at render time.
const base: CSSProperties = {
  display: "inline-block",
  padding: "2px 7px",
  borderRadius: 4,
  fontSize: "10.5px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

// TEACH: `Record<string, CSSProperties>` (rather than a strict union) is
// used here because we want to tolerate unexpected level strings from the
// backend without a TS error — we'll fall back to `colors.low` at runtime
// if the key isn't found. Trade-off: looser typing, more resilient UI.
const colors: Record<string, CSSProperties> = {
  high: { background: "var(--high)", color: "#fff" },
  medium: { background: "var(--medium)", color: "#111" },
  low: { background: "var(--low)", color: "#fff" },
};

// --- Props ---

// TEACH: `level` is a plain `string` (not a union) because it originates
// from the backend. The component defensively lowercases and falls back
// rather than crashing if the wire value drifts.
interface RiskBadgeProps {
  level: string;
  compact?: boolean;
}

// --- Component ---

export function RiskBadge({ level, compact }: RiskBadgeProps) {
  // TEACH: Normalize once so `colors[lowerLevel]` is a stable lookup and
  // the rendered text (further below) matches what we dispatched on.
  const lowerLevel = level.toLowerCase();

  // TEACH: A **ternary** (`cond ? A : B`) picks between two values. When
  // `compact` is truthy we shrink padding/font; otherwise `{}` means "no
  // override" and the base sizing wins.
  const sizeOverride: CSSProperties = compact
    ? { padding: "1px 6px", fontSize: "9.5px", letterSpacing: "0.4px" }
    : {};

  return (
    // TEACH: `colors[lowerLevel] ?? colors.low` uses the **nullish
    // coalescing operator** `??`. If the left side is `null` or
    // `undefined` (i.e. an unknown level like "critical"), it falls back
    // to `colors.low`. Unlike `||`, `??` does NOT fall back on `0` or `""`
    // — handy when those are valid values, though it doesn't matter here.
    <span style={{ ...base, ...(colors[lowerLevel] ?? colors.low), ...sizeOverride }}>
      {/* TEACH: We render `lowerLevel` as text; CSS `textTransform:
          uppercase` handles display-casing, so the DOM holds lowercase
          but the user sees uppercase. */}
      {lowerLevel}
    </span>
  );
}
