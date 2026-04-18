/**
 * Dot — a tiny coloured status indicator (a 7x7 round span).
 *
 * Visual role: rendered next to labels like "LIVE", "STOPPED", "LOADING" to
 * give the user a one-glance sense of system health. It is purely
 * presentational — it holds no state, does no fetching, and never mounts
 * anything other than a single <span>.
 *
 * Exports: the `Dot` component (a React "functional component").
 * Consumers: grep `import { Dot }` across `frontend/src/` — it is used in
 * headers/status strips inside pages like AdminPage, DashboardPage,
 * MonitoringPage, and inside other UI primitives (e.g. inside <Pill>).
 *
 * Styling: this primitive uses **inline styles** (a plain JS object passed
 * to the `style` prop on the <span>) rather than a `.module.css` file —
 * the component is so tiny that a CSS Module was overkill. Elsewhere in
 * the codebase you'll see `import styles from './Foo.module.css'`;
 * `className={styles.root}` — that pattern gives you *scoped* class names
 * (the bundler hashes them so `styles.root` becomes something like
 * `Foo_root__x7f2`, preventing CSS leakage between components).
 */

// TEACH: `import type { ... } from "react"` is a *type-only* import. At
// runtime nothing is pulled in — TypeScript uses this just for type
// checking, and the import is erased during compilation. `CSSProperties`
// is React's type for "a JS object that describes CSS rules" (keys are
// camelCased, e.g. `backgroundColor` not `background-color`).
import type { CSSProperties } from "react";

// --- Types ---

// TEACH: A *union type* — `DotVariant` can only ever be one of these four
// exact string literals. TypeScript will reject `variant="red"` at compile
// time because "red" is not in the set. This is how we get enum-like
// safety without the runtime cost of a real enum.
type DotVariant = "ok" | "bad" | "wait" | "default";

// TEACH: `Record<DotVariant, CSSProperties>` means: "an object whose keys
// are the four variant strings, and whose values are CSSProperties objects."
// TypeScript will error if we forget one of the four keys — a nice
// exhaustiveness check.
const styles: Record<DotVariant, CSSProperties> = {
  // TEACH: `var(--green)` references a CSS custom property (a.k.a. CSS
  // variable). The value is defined globally (see `frontend/src/index.css`
  // or similar) so theming lives in one place. Inline styles can reference
  // CSS variables just like stylesheets can.
  ok: { background: "var(--green)", boxShadow: "0 0 6px rgba(34,197,94,.5)" },
  // TEACH: `animation: "blink 1.5s infinite"` references a `@keyframes blink`
  // rule defined in global CSS. The dot pulses to draw attention when a
  // conflict is active.
  bad: { background: "var(--high)", animation: "blink 1.5s infinite" },
  wait: { background: "var(--medium)" },
  default: { background: "var(--low)" },
};

// TEACH: An `interface` describes the *shape* of the props object the
// component receives. `?` after a name makes a prop optional (so callers
// can write `<Dot />` without passing anything). Without `?` the caller
// MUST pass that prop or TypeScript complains.
interface DotProps {
  variant?: DotVariant;
  style?: CSSProperties;
}

// --- Component ---

// TEACH: This is a React **functional component** — just a function that
// takes a props object and returns JSX (React's HTML-like syntax that
// compiles to `React.createElement(...)` calls).
// The `{ variant = "default", style }` part is **destructuring** the props
// argument and giving `variant` a default value when the caller omits it.
// `: DotProps` annotates the argument type so TS can check call sites.
export function Dot({ variant = "default", style }: DotProps) {
  return (
    // TEACH: JSX looks like HTML but is actually JavaScript. Curly braces
    // `{...}` inside a tag switch back into JS expression mode. The `style`
    // attribute in JSX takes an *object*, not a CSS string — hence the
    // double braces: the outer `{}` enters JS, the inner `{}` is the
    // object literal.
    // The spread operator `...styles[variant]` copies every key from the
    // chosen variant's style object into this new object. Later spreads
    // override earlier ones, so `...style` last lets the caller tweak
    // individual properties (e.g. `style={{ marginLeft: 4 }}`).
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        display: "inline-block",
        ...styles[variant],
        ...style,
      }}
    />
  );
}
