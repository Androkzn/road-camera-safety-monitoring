/**
 * SummaryTiles — a row of four KPI tiles (Events / High / Medium / Uptime).
 *
 * Rendered by: pages/DashboardPage.tsx (top of the dashboard).
 *
 * Props (all supplied by DashboardPage from SSE-derived state):
 *   - total:     total event count since boot (number)
 *   - high:      count of high-risk events (number)
 *   - medium:    count of medium-risk events (number)
 *   - uptimeSec: server uptime in seconds; nullable while connecting
 *
 * React concepts first-taught in this file:
 *   - Functional component declared with `function` keyword
 *   - Typed Props via a TypeScript `interface`
 *   - Destructuring props in the parameter list
 *   - CSS Modules: `import styles from "./X.module.css"` → `styles.tile` etc.
 *   - Template-literal className composition (`${A} ${B}`)
 *   - Embedding a JS value into JSX with `{expr}`
 *   - Delegating formatting to a helper (see lib/format.ts::formatUptime)
 */

// --- Imports ---
// TEACH: Plain helper import. `formatUptime` turns seconds → "1h 24m" etc.
import { formatUptime } from "../../lib/format";
// TEACH: CSS Modules. Vite compiles SummaryTiles.module.css into a JS object
// whose keys are the local class names and whose values are globally-unique
// hashed class strings. This gives us component-scoped CSS with zero runtime
// cost — styles.tile might become "_tile_1a2b3_4" in the built CSS.
import styles from "./SummaryTiles.module.css";

// --- Types ---
// TEACH: A Props interface documents the component's public contract. The
// `?` suffix on `uptimeSec` makes it optional; the `| null` union allows
// explicit "not-loaded-yet" values from the parent.
interface SummaryTilesProps {
  total: number;
  high: number;
  medium: number;
  uptimeSec?: number | null;
}

// --- Render ---
// TEACH: A functional component is just a function that takes props and
// returns JSX. The `{ total, high, medium, uptimeSec }` syntax in the
// parameter list is object destructuring — it pulls those fields out of
// the single `props` argument React passes in.
export function SummaryTiles({ total, high, medium, uptimeSec }: SummaryTilesProps) {
  return (
    // TEACH: JSX is compiled to `React.createElement(...)` calls. `className`
    // (not `class`) is the React attribute for CSS classes.
    <div className={styles.summary}>
      {/* Tile 1: total events. `{total}` interpolates the prop value. */}
      <div className={styles.tile}>
        <div className={styles.label}>Events</div>
        <div className={styles.value}>{total}</div>
      </div>
      {/* Tile 2: high-risk. Two classes composed via template literal. */}
      <div className={`${styles.tile} ${styles.high}`}>
        <div className={styles.label}>High risk</div>
        <div className={styles.value}>{high}</div>
      </div>
      {/* Tile 3: medium-risk. Same compose-two-classes pattern. */}
      <div className={`${styles.tile} ${styles.medium}`}>
        <div className={styles.label}>Medium risk</div>
        <div className={styles.value}>{medium}</div>
      </div>
      {/* Tile 4: uptime. `formatUptime` gracefully handles null/undefined. */}
      <div className={styles.tile}>
        <div className={styles.label}>Uptime</div>
        <div className={styles.value}>{formatUptime(uptimeSec)}</div>
      </div>
    </div>
  );
}
