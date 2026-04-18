/**
 * WatchdogBadge — small "Monitoring" pill rendered in the global TopBar.
 *
 * Purpose:
 *   Surfaces the health of the background watchdog service (see
 *   road_safety/services/watchdog.py) at a glance. A coloured dot indicates
 *   the worst severity seen across current findings; a bubble shows the
 *   error count.
 *
 * Parent:
 *   Rendered by the TopBar / layout component and paired with a click handler
 *   that opens <WatchdogDrawer /> (see ./WatchdogDrawer.tsx).
 *
 * Data source:
 *   The `status` prop originates from `useWatchdogCtx()` in
 *   ../../hooks/WatchdogContext.tsx, which polls the backend every 15s.
 *   The parent reads the context and forwards `status` + `onClick` here.
 *
 * React concepts first taught here:
 *   - Early-return guard to render nothing (`return null`).
 *   - Nullable / optional chaining on prop fields (`status.by_severity?.error ?? 0`).
 *   - Nested ternary used to compute a discriminated string (the severity).
 *   - Parent-to-child callback prop (`onClick: () => void`).
 *   - Dynamic className lookup via bracket notation on a CSS-Modules object.
 */

import type { WatchdogStatus } from "../../types";
import styles from "./WatchdogBadge.module.css";

// --- Types ---

// TEACH: `onClick: () => void` is the TypeScript signature for a function
// that takes no args and returns nothing. Parents own the click behaviour
// (usually "open the drawer"); we just invoke this when the pill is clicked.
interface WatchdogBadgeProps {
  status: WatchdogStatus | null;
  onClick: () => void;
}

// --- Component ---

export function WatchdogBadge({ status, onClick }: WatchdogBadgeProps) {
  // TEACH: Early return. Returning `null` from a component renders nothing.
  // We skip the badge entirely while we have no status yet, or when the
  // watchdog feature is disabled on the backend.
  if (!status || !status.enabled) return null;

  // TEACH: `?.` is optional chaining. `?? 0` is nullish-coalescing: it picks
  // the right side when the left is null OR undefined (but NOT 0 or "").
  // So this reads as: "how many errors, defaulting to 0 if the map is missing."
  const errors = status.by_severity?.error ?? 0;
  const warnings = status.by_severity?.warning ?? 0;
  const total = status.total_findings;

  // TEACH: Nested ternary — reads as a chain of "if / else if / else". It
  // collapses a short decision tree into a single expression. Use sparingly;
  // long ternaries become unreadable.
  const severity =
    errors > 0 ? "error" : warnings > 0 ? "warning" : total > 0 ? "info" : "ok";

  // --- Render ---

  return (
    <div
      className={styles.badge}
      title="Error Monitoring — click to view findings"
      // TEACH: We forward the parent's callback directly. React invokes it
      // with a synthetic event, but since our prop signature ignores args,
      // that's fine.
      onClick={onClick}
      style={{ marginLeft: 8 }}
    >
      <span className={styles.label}>
        {/* TEACH: `styles[severity]` is a DYNAMIC class lookup — the CSS
            Modules `styles` object is keyed by class name, so we can pick
            `styles.error`, `styles.warning`, `styles.info`, or `styles.ok`
            at runtime based on the computed severity string. */}
        <span className={`${styles.dot} ${styles[severity]}`} />
        <span>Monitoring</span>
      </span>
      {/* Conditional count bubble. Only show when there is at least one error. */}
      {errors > 0 && (
        <span className={styles.errorBubble}>{errors}</span>
      )}
    </div>
  );
}
