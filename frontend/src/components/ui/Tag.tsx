/**
 * Tag — a small rectangular label used to annotate events with structured
 * metadata: a plate hash, a track ID, a "kin" grouping, etc.
 *
 * Visual role: dense, compact, colour-coded. Unlike <Pill> (pill-shaped,
 * used for top-level status), <Tag> is rectangular and used inline inside
 * event rows and cards. Variants colour-code the *kind* of metadata so
 * the reader can scan quickly:
 *   - "plate"   amber-on-black, monospace — a plate hash (never raw text!)
 *   - "hash"    blue, monospace            — generic hash/id
 *   - "kin"     green                      — kin group (related vehicles)
 *   - "kin-warn" red                       — flagged kin group
 *   - "track"   purple                     — perception track ID
 *   - "muted"   dim italic                 — placeholder / "—"
 *   - "default" neutral
 *
 * Exports: `Tag`. Consumers: grep `<Tag ` across `frontend/src/`.
 *
 * Privacy note: per CLAUDE.md, raw plate text must never reach the
 * frontend. When you see a "plate" <Tag>, the content is a hash, not the
 * real plate.
 *
 * Styling: inline styles (see Dot.tsx header for why — tiny primitive).
 */

// TEACH: `ReactNode` is the umbrella type for "anything React can render":
// strings, numbers, JSX elements, arrays of those, `null`, `undefined`,
// booleans. It's what you use for the `children` prop when you don't care
// what the caller passes.
import type { CSSProperties, ReactNode } from "react";

// --- Types ---

// TEACH: Note the quoted "kin-warn" — union members with a hyphen must be
// string literals (valid TS identifiers can't contain `-`), and the lookup
// later uses `variants["kin-warn"]` for the same reason.
type TagVariant = "default" | "plate" | "hash" | "muted" | "kin" | "kin-warn" | "track";

// --- Style tables ---

// TEACH: `base` holds the shared visual skeleton — every variant will
// spread this first, then layer its own colours on top.
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

// TEACH: Per-variant overrides. The empty `default: {}` is intentional —
// it keeps the `Record<TagVariant, CSSProperties>` exhaustive so TS knows
// every variant key is accounted for. Removing it would break the type.
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

// --- Props ---

// TEACH: `children: ReactNode` is a *special* prop name in React. When a
// caller writes `<Tag>some content</Tag>`, React automatically puts
// "some content" into `props.children`. It's what makes JSX composable.
// `title` (optional) maps to the native HTML `title` attribute, which
// browsers render as a tooltip on hover — useful to expose the full hash
// when the tag is visually truncated.
interface TagProps {
  variant?: TagVariant;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}

// --- Component ---

// TEACH: Destructuring in the parameter list again. `variant = "default"`
// gives a default for the optional prop. `children` receives whatever JSX
// the caller nested between <Tag>...</Tag>.
export function Tag({ variant = "default", title, children, style }: TagProps) {
  return (
    // TEACH: Three-way spread merge — `base` (shared), then the chosen
    // variant's overrides, then any caller-provided one-off `style` tweaks.
    // Order matters: later keys win.
    <span style={{ ...base, ...variants[variant], ...style }} title={title}>
      {/* TEACH: `{children}` renders whatever JSX/text the parent put
          inside the tag. This is the "slot" pattern. */}
      {children}
    </span>
  );
}
