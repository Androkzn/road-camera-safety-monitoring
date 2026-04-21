/**
 * TestBadge — pill summarising the latest pytest run, slotted into TopBar.
 *
 * Four visual states: idle / running / passed / failed. While running
 * shows a percentage; after a run shows pass/fail counts.
 *
 * --- UI mapping ---
 * Page: Global (TopBar of every page).
 * UI element: the small badge in the top bar showing test status
 *   (green/red); clicking it opens the TestDrawer.
 */
// `ReactNode` is the TS type for "anything renderable in JSX": a string,
// a number, an element, a fragment, an array of those, etc.
import type { ReactNode } from "react";

import type { TestStatus } from "../../../shared/types/common";

import styles from "./TestBadge.module.css";

/** Props for {@link TestBadge}. */
interface TestBadgeProps {
  status: TestStatus | null;
  onClick: () => void;
}

/**
 * Render the TopBar test-results pill. Click opens the {@link TestDrawer}.
 */
export function TestBadge({ status, onClick }: TestBadgeProps) {
  const state = status?.status ?? "idle";

  // Mutable locals populated by the state machine below — a lightweight
  // alternative to useMemo when the derivation is this trivial.
  let label = "Tests";
  let countsContent: ReactNode = null;

  if (state === "running") {
    label = "Running";
    const pct = status && status.total > 0 ? Math.round((status.progress / status.total) * 100) : 0;
    countsContent = <span>{pct}%</span>;
  } else if (state === "passed" || state === "failed") {
    label = state === "passed" ? "Passed" : "Failed";
    // Fragment `<>...</>` lets us return multiple siblings without a wrapper div.
    countsContent = (
      <>
        <span className={styles.cntPass}>{status?.passed ?? 0}</span>
        {(status?.failed ?? 0) > 0 && <span className={styles.cntFail}>{status?.failed}</span>}
      </>
    );
  }

  return (
    <div
      className={styles.badge}
      title="Click to view test results"
      onClick={onClick}
      style={{ marginLeft: 8 }}
    >
      <span className={`${styles.dot} ${styles[state]}`} />
      <span>{label}</span>
      {countsContent && <span className={styles.counts}>{countsContent}</span>}
    </div>
  );
}
