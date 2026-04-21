/**
 * TestDrawer.tsx — slide-out panel showing pytest run progress and results.
 *
 * What it does:
 *   Opens as an overlay drawer from the right edge of the Dashboard. Shows
 *   four summary tiles (total / passed / failed / skipped), a progress bar,
 *   per-file grouped test results with pass/fail icons and error messages,
 *   and a "Re-run Tests" button.
 *
 * Purpose:
 *   Lets the operator inspect the backend pytest suite without leaving the
 *   dashboard, and re-trigger it when they change code.
 *
 * How it works:
 *   - Props: `open` toggles visibility, `onClose` is called on overlay click
 *     or X button, `status` holds the full test run data (or null before the
 *     first fetch), `onRerun` kicks off a new run.
 *   - Results are grouped into a `byFile` dictionary by looping with `for`
 *     and appending into arrays per filename.
 *   - `Object.entries(byFile).map(...)` loops the dictionary and renders one
 *     file group per entry. Each test row inside that group is rendered by
 *     another `.map()` over the results array.
 *   - Conditional rendering (`state === "running" && ...`) swaps progress
 *     label text and bar color based on the backend's status string.
 *
 * Connects to:
 *   - Backend: data comes from the parent via `useTests` hook →
 *     `GET /api/tests/status` (polled) and `POST /api/tests/run` (onRerun).
 *   - UI: rendered by `pages/DashboardPage.tsx` as a sibling of the TopBar,
 *     toggled by `<TestBadge>` in the top bar.
 */
// Types describing the JSON coming back from /api/tests/status.
import type { TestStatus, TestResult } from "../../types";
import styles from "./TestDrawer.module.css";

// Icon glyph per test outcome — rendered on each row in the list.
const ICONS: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  error: "!",
  skipped: "○",
};

// Props: `open` toggles the slide-in, `onClose` handles overlay/X click,
// `status` is the full pytest snapshot (or null before first fetch), `onRerun` triggers a fresh run.
interface TestDrawerProps {
  open: boolean;
  onClose: () => void;
  status: TestStatus | null;
  onRerun: () => void;
}

// TestDrawer — slide-out panel from the right edge of the Dashboard page.
// Holds the summary tiles, progress bar, grouped test results, and the "Re-run Tests" button.
export function TestDrawer({ open, onClose, status, onRerun }: TestDrawerProps) {
  // Short alias for `status`. `d?.total ?? 0` = optional chaining + nullish coalescing:
  // if `d` is null, skip the access and use 0 instead.
  const d = status;
  const total = d?.total ?? 0;
  const passed = d?.passed ?? 0;
  const failed = d?.failed ?? 0;
  const skipped = d?.skipped ?? 0;
  const progress = d?.progress ?? 0;
  // Completion percentage for the progress bar width. Guarded against divide-by-zero.
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const state = d?.status ?? "idle";

  // Build the human-readable label under the progress bar based on run state.
  let progressLabel = "Waiting to start…";
  if (state === "running") progressLabel = `Running… ${progress}/${total}`;
  else if (state === "passed") progressLabel = `All ${total} tests passed`;
  else if (state === "failed")
    progressLabel = `${failed} test${failed !== 1 ? "s" : ""} failed`;

  // Pick a bar color class: green when all passed, red when any failed, empty (default) while running.
  const barClass =
    state === "passed"
      ? styles.donePass
      : state === "failed"
        ? styles.doneFail
        : "";

  // Group results into a { filename: [tests…] } dictionary so the list can show one section per test file.
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
      <div
        className={`${styles.overlay} ${open ? styles.open : ""}`}
        onClick={onClose}
      />
      <aside className={`${styles.drawer} ${open ? styles.open : ""}`}>
        <div className={styles.head}>
          <h2>Test Suite</h2>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
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
            <div
              className={`${styles.barFill} ${barClass}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className={styles.progressLabels}>
            <span>{progressLabel}</span>
            <span>
              {d && d.elapsed_sec > 0 ? `${d.elapsed_sec.toFixed(1)}s` : ""}
            </span>
          </div>
        </div>

        <div className={styles.testList}>
          {(!d?.results || d.results.length === 0) && (
            <div className={styles.emptyList}>
              {state === "running"
                ? "Running tests…"
                : "No test results yet"}
            </div>
          )}
          {Object.entries(byFile).map(([file, tests]) => {
            const allPassed = tests.every((t) => t.outcome === "passed");
            const anyFailed = tests.some(
              (t) => t.outcome === "failed" || t.outcome === "error",
            );
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
                    {t.message && (
                      <div className={styles.testError}>{t.message}</div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div className={styles.actions}>
          <button onClick={onRerun} disabled={state === "running"}>
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
