/**
 * TestBadge — a small pill rendered in the TopBar that summarizes the
 * latest backend pytest run. Clicking it opens the TestDrawer.
 *
 * Rendered by: App.tsx (or AdminPage), slotted into <TopBar>{here}</TopBar>.
 *
 * Props:
 *   - status:  latest `TestStatus` from the /api/tests endpoint, or null
 *              when we haven't polled yet.
 *   - onClick: callback supplied by the parent that opens the drawer.
 *
 * React concepts first-taught in this file:
 *   - Presentational ("dumb") component — no state, no effects, just props
 *     in / JSX out. Easiest pattern to reason about; favor this when
 *     possible.
 *   - `React.ReactNode` as a variable type so we can build up JSX
 *     imperatively before rendering.
 *   - React Fragment shorthand `<>...</>` — groups children without
 *     introducing a DOM element. Useful when a component must return
 *     exactly one root but you don't want a wrapper div.
 *   - Deriving display strings from state with `if/else if` before JSX.
 *   - Parent-owned state: the badge itself doesn't know if the drawer is
 *     open — it just calls `onClick`, and the parent decides.
 */

// --- Imports ---
// TEACH: Types-only import — stripped at build time.
import type { TestStatus } from "../../types";
import styles from "./TestBadge.module.css";

// --- Types ---
interface TestBadgeProps {
  // `| null` — lets the parent say "I have no data yet".
  status: TestStatus | null;
  // TEACH: Callback prop. Parent owns the "is drawer open?" state; we
  // simply notify on click. This is how you keep a component reusable.
  onClick: () => void;
}

// --- Render ---
export function TestBadge({ status, onClick }: TestBadgeProps) {
  // TEACH: Derive `state` once. `status?.status` might look odd — the outer
  // object is a TestStatus whose `.status` field is the run state string
  // ("idle" | "running" | "passed" | "failed"). Optional-chain, then fall
  // back to "idle" if no data yet.
  const state = status?.status ?? "idle";

  // TEACH: Build up JSX imperatively before the return. `React.ReactNode`
  // is the "anything renderable" type. We default to `null` (renders
  // nothing) and override inside the state branches.
  let label = "Tests";
  let countsContent: React.ReactNode = null;

  if (state === "running") {
    label = "Running";
    // TEACH: Compute progress percentage safely — guard against total=0
    // to avoid NaN from 0/0.
    const pct = status && status.total > 0
      ? Math.round((status.progress / status.total) * 100)
      : 0;
    countsContent = <span>{pct}%</span>;
  } else if (state === "passed" || state === "failed") {
    label = state === "passed" ? "Passed" : "Failed";
    countsContent = (
      // TEACH: React Fragment `<>...</>`. A component must return a single
      // root node, but sometimes you need multiple siblings without
      // wrapping them in a div. Fragments render nothing to the DOM.
      <>
        <span className={styles.cntPass}>{status?.passed ?? 0}</span>
        {/* TEACH: Conditional `&&` render — failed count badge only when
            there's at least one failure. */}
        {(status?.failed ?? 0) > 0 && (
          <span className={styles.cntFail}>{status?.failed}</span>
        )}
      </>
    );
  }

  return (
    <div
      className={styles.badge}
      title="Click to view test results"
      // TEACH: Pass the prop reference straight through. React will call
      // `onClick(event)` on click; we ignore the event argument.
      onClick={onClick}
      // TEACH: One-off layout nudge with inline style. Preferred long-term
      // path would be a dedicated CSS class; fine for a single value.
      style={{ marginLeft: 8 }}
    >
      {/* TEACH: `styles[state]` does a computed lookup on the CSS-Modules
          object — so a run state of "passed" pulls the `.passed` class.
          This works because state values exactly match class names. */}
      <span className={`${styles.dot} ${styles[state]}`} />
      <span>{label}</span>
      {/* TEACH: Only render the counts container when we actually built
          content for it (null is falsy → renders nothing). */}
      {countsContent && <span className={styles.counts}>{countsContent}</span>}
    </div>
  );
}
