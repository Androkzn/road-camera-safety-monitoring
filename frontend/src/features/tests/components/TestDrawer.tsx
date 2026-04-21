/**
 * TestDrawer — slide-in panel showing detailed pytest results.
 *
 * Summary tiles on top, progress bar in the middle, collapsible
 * per-file groups below. Kicks a rerun via the parent-provided callback.
 *
 * --- UI mapping ---
 * Page: Global (TopBar of every page).
 * UI element: the drawer that slides out from the side showing the pytest
 *   run output (summary tiles, progress bar, per-file collapsible groups).
 * Backend: triggers POST /api/tests/run via the parent component.
 */

import type { TestStatus, TestResult } from "../../../shared/types/common";

import styles from "./TestDrawer.module.css";

// `Record<K, V>` is a TS utility type — an object whose keys are of
// type K and values are V. Used here as a small lookup table.
const ICONS: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  error: "!",
  skipped: "○",
};

/** Props for {@link TestDrawer}. */
interface TestDrawerProps {
  open: boolean;
  onClose: () => void;
  status: TestStatus | null;
  onRerun: () => void;
}

/**
 * Drawer component — parent controls visibility via the `open` prop.
 * We rely on CSS transitions for the slide animation rather than
 * unmounting, so closing doesn't drop scroll state.
 */
export function TestDrawer({ open, onClose, status, onRerun }: TestDrawerProps) {
  const d = status;
  const total = d?.total ?? 0;
  const passed = d?.passed ?? 0;
  const failed = d?.failed ?? 0;
  const skipped = d?.skipped ?? 0;
  const progress = d?.progress ?? 0;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const state = d?.status ?? "idle";

  let progressLabel = "Waiting to start…";
  if (state === "running") progressLabel = `Running… ${progress}/${total}`;
  else if (state === "passed") progressLabel = `All ${total} tests passed`;
  else if (state === "failed") progressLabel = `${failed} test${failed !== 1 ? "s" : ""} failed`;

  const barClass = state === "passed" ? styles.donePass : state === "failed" ? styles.doneFail : "";

  // Bucket individual test results by their source file for grouped display.
  // The trailing `!` is TS "non-null assertion" — we just initialised
  // `byFile[f]` on the line above, so TS can safely treat it as non-undefined.
  const byFile: Record<string, TestResult[]> = {};
  if (d?.results) {
    for (const t of d.results) {
      const f = t.file || "unknown";
      if (!byFile[f]) byFile[f] = [];
      byFile[f]!.push(t);
    }
  }

  return (
    <>
      <div className={`${styles.overlay} ${open ? styles.open : ""}`} onClick={onClose} />
      <aside className={`${styles.drawer} ${open ? styles.open : ""}`}>
        <div className={styles.head}>
          <h2>Test Suite</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} title="Close">
            &times;
          </button>
        </div>

        <div className={styles.summaryGrid}>
          <SummaryTile label="Total" value={total} variant="total" />
          <SummaryTile label="Passed" value={passed} variant="pass" />
          <SummaryTile label="Failed" value={failed} variant="fail" />
          <SummaryTile label="Skipped" value={skipped} variant="skip" />
        </div>

        <div className={styles.progress}>
          <div className={styles.barWrap}>
            <div className={`${styles.barFill} ${barClass}`} style={{ width: `${pct}%` }} />
          </div>
          <div className={styles.progressLabels}>
            <span>{progressLabel}</span>
            <span>{d && d.elapsed_sec > 0 ? `${d.elapsed_sec.toFixed(1)}s` : ""}</span>
          </div>
        </div>

        <div className={styles.testList}>
          {(!d?.results || d.results.length === 0) && (
            <div className={styles.emptyList}>
              {state === "running" ? "Running tests…" : "No test results yet"}
            </div>
          )}
          {Object.entries(byFile).map(([file, tests]) => {
            const allPassed = tests.every((t) => t.outcome === "passed");
            const anyFailed = tests.some((t) => t.outcome === "failed" || t.outcome === "error");
            const fileIcon = anyFailed ? "✗" : allPassed ? "✓" : "○";
            const fileColor = anyFailed
              ? "var(--high)"
              : allPassed
                ? "var(--green)"
                : "var(--muted)";

            return (
              <div className={styles.fileGroup} key={file}>
                <div className={styles.fileHeader}>
                  <span style={{ color: fileColor }}>{fileIcon}</span> {file}
                </div>
                {tests.map((t) => (
                  <div key={t.node_id}>
                    <div className={styles.testItem}>
                      <span className={`${styles.testIcon} ${styles[t.outcome]}`}>
                        {ICONS[t.outcome] ?? "?"}
                      </span>
                      <span className={styles.testName} title={t.node_id}>
                        {t.name}
                      </span>
                      <span className={styles.testDur}>
                        {t.duration_ms > 0 ? `${t.duration_ms.toFixed(0)}ms` : ""}
                      </span>
                    </div>
                    {t.message && <div className={styles.testError}>{t.message}</div>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div className={styles.actions}>
          <button type="button" onClick={onRerun} disabled={state === "running"}>
            Re-run Tests
          </button>
          <span className={styles.elapsed}>
            {state !== "running" && d && d.elapsed_sec > 0
              ? `Completed in ${d.elapsed_sec.toFixed(1)}s`
              : ""}
          </span>
        </div>
      </aside>
    </>
  );
}

/**
 * SummaryTile — one of the four top-of-drawer count boxes.
 *
 * Inline type annotation (no separate `interface`) since this helper
 * is file-local and only used in one place.
 */
function SummaryTile({
  label,
  value,
  variant,
}: {
  label: string;
  value: number | string;
  variant: string;
}) {
  return (
    <div className={`${styles.tile} ${styles[`t${variant}`]}`}>
      <div className={styles.tLabel}>{label}</div>
      <div className={styles.tValue}>{value || "—"}</div>
    </div>
  );
}
