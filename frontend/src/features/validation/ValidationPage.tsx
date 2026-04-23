/**
 * ValidationPage — the heavy shadow-mode dual-model validator tab.
 *
 * Split out of MonitoringPage so the watchdog incident queue stays
 * focused on "what's wrong with the system" and this tab stays focused
 * on "where do the two detectors disagree". Consumes the same
 * event-stream + watchdog context every other tab uses; no new
 * server calls live here.
 *
 * This is a React functional component — a plain function that returns
 * JSX (React's HTML-like syntax). React calls it to render the page.
 *
 * --- UI mapping ---
 * Page: ValidationPage ([file](frontend/src/features/validation/ValidationPage.tsx))
 * UI element: the validation page shell where reviewers grade detections —
 *   contains the ValidatorControl card and the EventsPanel list.
 */
// `useMemo` is a React hook: caches a computed value across renders
// and only recomputes when its dependency array changes. Prevents
// redoing expensive work on every re-render.
import { useMemo } from "react";

import { useEventStream } from "../../shared/hooks/useEventStream";
import { useLiveStatus } from "../../shared/hooks/useLiveStatus";
import { TopBar } from "../../shared/layout/TopBar";
import { useWatchdogCtx } from "../watchdog";

import { EventsPanel, ValidatorControl } from "./components";
import { useValidator } from "./hooks/useValidator";
import { useDriftCount } from "./hooks/useDriftCount";

import styles from "./ValidationPage.module.css";

/**
 * ValidationPage — page component rendered when the /validation route is active.
 *
 * Aggregates four data sources (live SSE stream, live camera status,
 * watchdog findings, validator toggle state) and splits the watchdog
 * findings into the two headline stats shown on top of the page.
 */
export function ValidationPage() {
  // Custom hooks (any function starting with `use`): they wrap React's
  // built-in hooks and return state/data to the component. Destructuring
  // pulls named fields out of the returned object.
  const { connected, events } = useEventStream();
  // Renaming during destructuring: `data` (from useQuery) becomes `liveStatus`.
  const { data: liveStatus } = useLiveStatus();
  const { status: wdStatus, findings } = useWatchdogCtx();
  const { status: validatorStatus } = useValidator();

  // Double-bang `!!x` coerces a possibly-undefined value to a strict boolean.
  const validatorActive = !!validatorStatus?.enabled && !validatorStatus?.paused;
  const driftCount = useDriftCount();
  // `??` is the nullish-coalescing operator: use the left side unless it's
  // null/undefined. Safer than `||` which also falls back on "" or 0.
  const sourceName = liveStatus?.source ?? "—";

  // Memoized split of validator findings. Recomputes only when
  // `findings` identity changes — saves work on every re-render.
  const { disputed, shadowOnly } = useMemo(() => {
    const validator = (findings ?? []).filter((f) => f.category === "validator");
    return {
      // False-positive / class-mismatch: primary said yes, validator said no.
      disputed: validator.filter((f) => !(f.fingerprint ?? "").endsWith("false-negative")).length,
      // False-negative: validator flagged something the primary missed.
      shadowOnly: validator.filter((f) => (f.fingerprint ?? "").endsWith("false-negative")).length,
    };
  }, [findings]);

  // JSX returned below: React's syntax for describing UI. Looks like HTML but
  // compiles to React.createElement() calls. `<>...</>` is a "Fragment" — a
  // wrapper that groups siblings without adding an extra DOM node.
  return (
    <>
      {/* Props are passed like HTML attributes; `{expr}` inlines a JS value. */}
      <TopBar
        sourceName={sourceName}
        connected={connected}
        errorCount={wdStatus?.by_severity?.error ?? 0}
        driftCount={driftCount}
      />

      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <h1>Validation</h1>
            <p className={styles.subtitle}>
              A second, heavier detector runs in the background and cross-checks every primary
              finding. Disagreements and misses surface here so you can spot drift without gating
              live alerts.
            </p>
          </div>

          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Disputed events</span>
              <span className={`${styles.statValue} ${styles.drift}`}>
                {disputed.toLocaleString()}
              </span>
              <span className={styles.statHint}>
                Primary detector's verdict the secondary disagrees with (false positive or class
                mismatch).
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Shadow-only detections</span>
              <span className={`${styles.statValue} ${styles.drift}`}>
                {shadowOnly.toLocaleString()}
              </span>
              <span className={styles.statHint}>
                Events the shadow model flagged but the primary missed — candidate false negatives.
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Drift total</span>
              <span className={`${styles.statValue} ${styles.drift}`}>
                {driftCount.toLocaleString()}
              </span>
              <span className={styles.statHint}>Combined drift count shown on the nav bubble.</span>
            </div>
          </div>

          <ValidatorControl />
        </div>

        <div className={styles.content}>
          <EventsPanel
            events={events}
            findings={findings ?? []}
            validatorEnabled={validatorActive}
          />
        </div>
      </div>
    </>
  );
}
