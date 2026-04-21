/**
 * TestBadge.tsx — compact clickable chip that summarizes the pytest run.
 *
 * What it does:
 *   Shows a small colored dot plus a label ("Tests" / "Running" / "Passed" /
 *   "Failed") and, when available, a running percent or pass/fail counts.
 *   Clicking opens the `<TestDrawer>` for details.
 *
 * Purpose:
 *   Gives dashboard users a persistent, low-profile view of the backend
 *   test-suite health right next to the connection pill in the top bar.
 *
 * How it works:
 *   - Props: `status` (nullable TestStatus object from the backend) and
 *     `onClick` (handler that opens the drawer).
 *   - `status?.status ?? "idle"` uses optional chaining and `??` (nullish
 *     coalescing): if status is null, falls back to "idle".
 *   - `countsContent` is built via conditional logic and rendered inline in
 *     JSX only when it is non-null (`countsContent && <span>…</span>` means
 *     "render this span only if countsContent is truthy").
 *
 * Connects to:
 *   - Backend: receives data fetched by `useTests` hook in the parent
 *     (`GET /api/tests/status`). Itself does not fetch.
 *   - UI: rendered by `pages/DashboardPage.tsx` inside the `<TopBar>`
 *     children slot; clicking it toggles the sibling `<TestDrawer>`.
 */
import type { TestStatus } from "../../types";
import styles from "./TestBadge.module.css";

interface TestBadgeProps {
  status: TestStatus | null;
  onClick: () => void;
}

export function TestBadge({ status, onClick }: TestBadgeProps) {
  const state = status?.status ?? "idle";

  let label = "Tests";
  let countsContent: React.ReactNode = null;

  if (state === "running") {
    label = "Running";
    const pct = status && status.total > 0
      ? Math.round((status.progress / status.total) * 100)
      : 0;
    countsContent = <span>{pct}%</span>;
  } else if (state === "passed" || state === "failed") {
    label = state === "passed" ? "Passed" : "Failed";
    countsContent = (
      <>
        <span className={styles.cntPass}>{status?.passed ?? 0}</span>
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
      onClick={onClick}
      style={{ marginLeft: 8 }}
    >
      <span className={`${styles.dot} ${styles[state]}`} />
      <span>{label}</span>
      {countsContent && <span className={styles.counts}>{countsContent}</span>}
    </div>
  );
}
