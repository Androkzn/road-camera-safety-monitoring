/**
 * TestDrawer — slide-in side panel showing detailed pytest results
 * (summary tiles, progress bar, per-file grouped test rows, re-run button).
 *
 * Rendered by: App.tsx. Opens when the user clicks TestBadge.
 *
 * Props:
 *   - open:     whether the drawer is visible — parent owns this state.
 *   - onClose:  callback to dismiss (clicking overlay or X button).
 *   - status:   latest TestStatus from /api/tests (null while loading).
 *   - onRerun:  callback to kick a new pytest run from the browser.
 *
 * React concepts first-taught in this file:
 *   - "Portal-less modal" pattern: overlay + drawer sit side-by-side as
 *     siblings under a Fragment. CSS handles the fixed positioning.
 *   - Open/close via CSS class toggle (`open ? styles.open : ""`) rather
 *     than mount/unmount — this lets CSS animate the transition.
 *   - Grouping a flat array into a record with a plain `for...of` loop.
 *   - `Object.entries(record).map(...)` for nested list rendering.
 *   - Stable `key` on both the outer group and the inner item.
 *   - Conditional rendering variants: `&&`, ternary, string-assignment
 *     to a `let` variable based on state.
 *   - Defining a *helper sub-component* in the same file for readability.
 *   - Inline object types in a sub-component's props (when an interface
 *     feels like overkill for a one-off local component).
 */

// --- Imports ---
import type { TestStatus, TestResult } from "../../types";
import styles from "./TestDrawer.module.css";

// --- Constants ---
// TEACH: Module-scope lookup table — one-time allocation shared across
// renders. `Record<string, string>` reads as "an object whose keys are
// strings and whose values are strings".
const ICONS: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  error: "!",
  skipped: "○",
};

// --- Types ---
interface TestDrawerProps {
  open: boolean;
  onClose: () => void;
  status: TestStatus | null;
  onRerun: () => void;
}

// --- Render ---
export function TestDrawer({ open, onClose, status, onRerun }: TestDrawerProps) {
  // TEACH: Alias `status` → `d` for brevity below. A bunch of fields need
  // null-safe reads; pull them once with `??` defaults so the JSX stays
  // clean.
  const d = status;
  const total = d?.total ?? 0;
  const passed = d?.passed ?? 0;
  const failed = d?.failed ?? 0;
  const skipped = d?.skipped ?? 0;
  const progress = d?.progress ?? 0;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const state = d?.status ?? "idle";

  // TEACH: Build the progress label with `let` + conditional assignment.
  // Easier to read than a nested ternary when you have 3+ branches.
  let progressLabel = "Waiting to start…";
  if (state === "running") progressLabel = `Running… ${progress}/${total}`;
  else if (state === "passed") progressLabel = `All ${total} tests passed`;
  else if (state === "failed")
    progressLabel = `${failed} test${failed !== 1 ? "s" : ""} failed`;

  // TEACH: Ternary chain to pick a class. `barClass` is "" when idle/running
  // so the bar uses its default style.
  const barClass =
    state === "passed"
      ? styles.donePass
      : state === "failed"
        ? styles.doneFail
        : "";

  // TEACH: Group the flat results array by filename. This is plain JS (not
  // React-specific). We'll iterate `byFile` in the JSX to render grouped
  // sections. Doing this transform *before* JSX keeps the markup readable.
  const byFile: Record<string, TestResult[]> = {};
  if (d?.results) {
    for (const t of d.results) {
      const f = t.file || "unknown";
      if (!byFile[f]) byFile[f] = [];
      byFile[f]!.push(t);
    }
  }

  return (
    // TEACH: Fragment `<>...</>` lets us return two siblings (overlay +
    // drawer) without a wrapper div. Both are fixed-positioned by CSS, so
    // they don't need a shared parent in the layout sense.
    <>
      {/* TEACH: Click-outside-to-close. The overlay is a full-screen
          transparent-ish layer that captures clicks and calls onClose.
          Toggling `styles.open` with a className triggers a CSS transition
          (fade-in); when `open` is false the overlay is visually hidden
          via CSS (opacity/pointer-events), not unmounted. */}
      <div
        className={`${styles.overlay} ${open ? styles.open : ""}`}
        onClick={onClose}
      />
      <aside className={`${styles.drawer} ${open ? styles.open : ""}`}>
        {/* Drawer header: title + close button */}
        <div className={styles.head}>
          <h2>Test Suite</h2>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            {/* TEACH: `&times;` is the HTML entity for ×. JSX allows
                entities inside text nodes just like HTML. */}
            &times;
          </button>
        </div>

        {/* 4-tile summary. Using a local sub-component SummaryTile defined
            below to avoid repeating the tile markup four times. */}
        <div className={styles.summaryGrid}>
          <SummaryTile label="Total" value={total} variant="total" />
          <SummaryTile label="Passed" value={passed} variant="pass" />
          <SummaryTile label="Failed" value={failed} variant="fail" />
          <SummaryTile label="Skipped" value={skipped} variant="skip" />
        </div>

        {/* Progress bar */}
        <div className={styles.progress}>
          <div className={styles.barWrap}>
            {/* TEACH: Inline style for a DYNAMIC value (`width: pct%`).
                This is the legitimate use case for inline style: values
                that are computed at render time and can't be pre-defined
                as static classes. */}
            <div
              className={`${styles.barFill} ${barClass}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className={styles.progressLabels}>
            <span>{progressLabel}</span>
            <span>
              {/* TEACH: `&&` guard + ternary — show elapsed time only when
                  we have a run result with positive elapsed. */}
              {d && d.elapsed_sec > 0 ? `${d.elapsed_sec.toFixed(1)}s` : ""}
            </span>
          </div>
        </div>

        {/* Test list, grouped by file */}
        <div className={styles.testList}>
          {/* TEACH: Empty-state rendering. When there are no results yet
              we show a placeholder message instead of an empty list. */}
          {(!d?.results || d.results.length === 0) && (
            <div className={styles.emptyList}>
              {state === "running"
                ? "Running tests…"
                : "No test results yet"}
            </div>
          )}
          {/* TEACH: `Object.entries(byFile)` → array of `[filename, tests]`
              tuples. We destructure them in the `.map` callback so `file`
              is the key and `tests` is the array of results under it. */}
          {Object.entries(byFile).map(([file, tests]) => {
            // TEACH: Derived per-group flags using Array.every/some. These
            // drive the file-header icon and color.
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
              // TEACH: Outer group key = filename (unique within one list).
              <div className={styles.fileGroup} key={file}>
                <div className={styles.fileHeader}>
                  <span style={{ color: fileColor }}>{fileIcon}</span> {file}
                </div>
                {/* Nested map for the individual tests within the file. */}
                {tests.map((t) => (
                  // TEACH: Inner key = pytest `node_id`, which is globally
                  // unique (e.g. "tests/test_core.py::test_foo"). Never use
                  // the array index here — test order can change between
                  // runs and React would misattribute state.
                  <div key={t.node_id}>
                    <div className={styles.testItem}>
                      {/* TEACH: `styles[t.outcome]` — computed class lookup
                          so "passed" → .passed, "failed" → .failed, etc. */}
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
                    {/* TEACH: Conditional render of the error message
                        — only when pytest returned one. */}
                    {t.message && (
                      <div className={styles.testError}>{t.message}</div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* Footer: re-run button + completion time */}
        <div className={styles.actions}>
          {/* TEACH: `disabled` prop prevents spamming the backend when a
              run is already in flight. Derived UI from state (again). */}
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

// TEACH: Helper sub-component defined in the same file. Perfectly valid
// React — you don't need a new file for every small component. Inline
// object type is used here (`{ label: ..., value: ..., variant: ... }`)
// instead of a top-level interface because this component is private to
// TestDrawer and its shape isn't reused elsewhere.
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
    // TEACH: `styles[`t${variant}`]` builds the class name at runtime —
    // variant "pass" → class "tpass". Works because the CSS file defines
    // .ttotal, .tpass, .tfail, .tskip to match.
    <div className={`${styles.tile} ${styles[`t${variant}`]}`}>
      <div className={styles.tLabel}>{label}</div>
      {/* TEACH: `value || "—"` shows an em-dash when value is 0 or empty.
          Subtle: because `||` treats 0 as falsy, a zero value becomes
          "—". If you wanted to show the literal 0 you'd use `?? "—"`
          instead (nullish-coalescing doesn't consider 0 as "missing"). */}
      <div className={styles.tValue}>{value || "—"}</div>
    </div>
  );
}
