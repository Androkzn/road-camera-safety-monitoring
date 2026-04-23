/**
 * Tag — small rectangular label for structured event metadata
 * (plate hash, track id, kin grouping, …). Variant colour-codes the
 * kind of metadata so a reader can scan rows quickly.
 *
 * Purpose: give a single piece of metadata a tight, colour-coded chip
 *   so dense event rows stay scannable.
 * Visual role: inline-block span, mono font for identifiers, dark
 *   palette to blend with the app's dark theme.
 *
 * Privacy note: per CLAUDE.md, raw plate text MUST NEVER reach the
 * frontend — when you see a "plate" Tag, the content is a hash.
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Most visible on EventCard
 *   rows (DashboardPage, AdminPage, MonitoringPage) and inside event
 *   detail dialogs.
 * UI element: small rectangular metadata label (track id, plate hash,
 *   kin grouping, etc.) — colour-coded by variant so the operator can
 *   scan rows quickly.
 */
import type { CSSProperties, ReactNode } from "react";

// Semantic variants. Each maps to a palette below; the name describes
// the kind of metadata, not the colour, so themes can restyle later.
//   default    — neutral grey chip (fallback).
//   plate      — amber; a hashed licence plate identifier.
//   hash       — blue; generic hash (event id, thumbnail hash, etc.).
//   muted      — dim italic; de-emphasised/placeholder value.
//   kin        — green; co-travelling vehicle grouping.
//   kin-warn   — red; kin grouping that tripped a warning heuristic.
//   track      — purple; internal ByteTrack track id.
type TagVariant = "default" | "plate" | "hash" | "muted" | "kin" | "kin-warn" | "track";

// Shared base style applied to every Tag before the variant overrides.
const base: CSSProperties = {
  display: "inline-block",
  padding: "2px 7px",
  borderRadius: 4,
  background: "#0b0f14",
  border: "1px solid var(--border)",
  color: "var(--muted)",
  fontSize: "10.5px",
  letterSpacing: "0.3px",
};

// Per-variant overrides layered on top of `base`. Empty `default` keeps
// base styling; mono font is used wherever the content is an identifier
// so glyph widths align across rows.
const variants: Record<TagVariant, CSSProperties> = {
  default: {},
  plate: {
    background: "#1a1300",
    borderColor: "#3f2b00",
    color: "#fbbf24",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    letterSpacing: "1px",
  },
  hash: {
    background: "#0a1a2e",
    borderColor: "#1e3a5f",
    color: "#7dd3fc",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
  },
  muted: { opacity: 0.6, fontStyle: "italic" },
  kin: {
    background: "#0a1a0e",
    borderColor: "#14532d",
    color: "#86efac",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  },
  "kin-warn": {
    background: "#2a0f0f",
    borderColor: "#7f1d1d",
    color: "#fca5a5",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  },
  track: {
    background: "#1a1022",
    borderColor: "#3f1d5f",
    color: "#c4b5fd",
    fontFamily: "var(--font-mono)",
  },
};

// Props:
//   variant  — one of TagVariant; selects the palette (default: "default").
//   title    — native tooltip text on hover (useful for truncated hashes).
//   children — the label content; typically a short string or number.
//   style    — last-word inline overrides merged after base + variant.
interface TagProps {
  variant?: TagVariant;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}

/**
 * Renders a single label chip.
 *
 * a11y: purely visual; no role assigned because the surrounding row
 *   (e.g. EventCard) is what carries semantic meaning. Use `title` to
 *   expose the full value when the visible text is truncated.
 * Style precedence: base → variant → caller `style` (caller wins).
 */
export function Tag({ variant = "default", title, children, style }: TagProps) {
  return (
    <span style={{ ...base, ...variants[variant], ...style }} title={title}>
      {children}
    </span>
  );
}
