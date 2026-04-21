/**
 * Tag.tsx — small inline label used to show metadata chips.
 *
 * What it does:
 *   Renders a short, boxed label (like "TTC 1.2s", a track ID "#42", or a
 *   license-plate hash). The `variant` prop picks a visual theme: plate (amber
 *   mono), hash (blue mono), kin/kin-warn (green/red kinematics), track
 *   (purple), muted, or default.
 *
 * Purpose:
 *   Standardizes how event metadata — plate hashes, track IDs, distances,
 *   time-to-collision, episode durations — appears across event cards.
 *
 * How it works:
 *   - Props: `variant` (which theme), `title` (HTML tooltip on hover),
 *     `children` (the text/nodes inside — ReactNode means "anything
 *     renderable"), and `style` for caller overrides.
 *   - The final `style` merges three objects: base rules, variant rules, and
 *     caller overrides. Later keys win.
 *
 * Connects to:
 *   - Backend: none — display-only.
 *   - UI: used by `EventCard.tsx` and `AdminEventCard.tsx` under
 *     frontend/src/components/events/ to render kinematic and vehicle tags.
 */
// `ReactNode` = any renderable value (string, number, JSX element, array, null, etc.).
// `CSSProperties` = object shape of React's inline `style={{ ... }}` prop.
import type { CSSProperties, ReactNode } from "react";

// Allowed visual themes for a tag. Each one is a preset in the `variants` table below.
type TagVariant = "default" | "plate" | "hash" | "muted" | "kin" | "kin-warn" | "track";

// Shared styling that every tag gets regardless of variant:
// small rectangular chip, 2x7 px padding, 4 px radius, dark panel background, muted gray text, tiny font.
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

// Per-variant overrides layered on top of `base`. Each variant gives the chip a distinct color theme.
// default = plain gray, plate = amber mono (license plate), hash = blue mono (hash code),
// muted = faded italic, kin = green mono (safe kinematics), kin-warn = red mono (dangerous kinematics),
// track = purple mono (tracker ID).
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

// Props: `variant` picks color theme, `title` sets the native browser tooltip,
// `children` is the label content between <Tag>…</Tag>, `style` allows per-call overrides.
interface TagProps {
  variant?: TagVariant;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}

// Tag — small rectangular metadata chip displayed inside event cards.
// Appears wherever kinematic values, plate hashes, or track IDs need a colored label.
export function Tag({ variant = "default", title, children, style }: TagProps) {
  return (
    /* Single inline chip. Styles are layered: base → variant preset → caller override (last wins).
       The `title` attribute shows a native OS tooltip on hover. */
    <span style={{ ...base, ...variants[variant], ...style }} title={title}>
      {children}
    </span>
  );
}
