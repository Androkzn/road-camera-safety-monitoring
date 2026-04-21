/**
 * EventRow — one primary-detector event line inside EventsPanel.
 *
 * Split out of EventsPanel.tsx as part of DV1 (frontend audit
 * 2026-04-20): the panel now only handles list controls + iteration,
 * and this component owns the per-row presentation. Uses the shared
 * EventsPanel.module.css stylesheet so DOM + classNames stay
 * byte-identical to the pre-split output.
 *
 * --- UI mapping ---
 * Page: ValidationPage ([file](frontend/src/features/validation/ValidationPage.tsx))
 * UI element: each row in the events list inside EventsPanel (time,
 *   risk badge, objects, verdict pill).
 */
import { cx } from "../../../shared/lib/cx";
// `import type` imports only TypeScript type definitions — erased at
// build time, zero runtime cost.
import type { SafetyEvent } from "../../../shared/types/common";
import { RiskBadge } from "../../../shared/ui";
import {
  disputeDetail,
  formatConfidencePct,
  formatObjects,
  formatTime,
  humanize,
  verdictLabel,
  type DisputeInfo,
  type Verdict,
} from "../utils/verdict";

// CSS Modules: class names are scoped per-file at build time. `styles.row`
// becomes something like `EventsPanel_row__a1b2c` so styles don't collide.
import styles from "./EventsPanel.module.css";

/**
 * Props contract for {@link EventRow}.
 *
 * `interface` declares an object shape in TypeScript. The `?` marks a
 * field as optional — callers may omit it. `() => void` is a callback
 * type: a function taking no args and returning nothing.
 */
export interface EventRowProps {
  ev: SafetyEvent;
  verdict: Verdict;
  dispute?: DisputeInfo;
  onClick?: () => void;
}

/**
 * Render a single event as a clickable row. The row is keyboard-accessible
 * when `onClick` is supplied — Enter or Space triggers the same handler
 * as a mouse click, and ARIA attributes advertise the button role.
 */
// Props are destructured directly in the parameter list with a type annotation.
export function EventRow({ ev, verdict, dispute, onClick }: EventRowProps) {
  const risk = ev.risk_level;
  const objects = formatObjects(ev.objects);
  const conf = formatConfidencePct(ev.confidence);

  // Nested ternary picks one of three CSS classes based on verdict.
  const badgeClass =
    verdict === "verified"
      ? styles.badgeVerified
      : verdict === "disputed"
        ? styles.badgeDisputed
        : styles.badgePending;

  return (
    // `cx(...)` joins truthy class names — `onClick && styles.rowClickable`
    // adds the clickable style only when a handler was provided.
    <div
      className={cx(styles.row, styles[risk], onClick && styles.rowClickable)}
      onClick={onClick}
      // ARIA role + tabIndex make the div behave like a button for screen
      // readers + keyboard users when it's actually interactive.
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        // Mirror native button behaviour: Space or Enter activates.
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className={styles.time}>{formatTime(ev.wall_time)}</span>
      <div className={styles.mid}>
        <div className={styles.midTop}>
          <span className={styles.eventType}>{humanize(ev.event_type)}</span>
          <RiskBadge level={risk} compact />
        </div>
        <div className={styles.meta}>
          {objects || "—"}
          {ev.vehicle_id ? ` · ${humanize(ev.vehicle_id)}` : ""}
          {typeof ev.ttc_sec === "number" ? ` · TTC ${ev.ttc_sec.toFixed(1)}s` : ""}
        </div>
      </div>
      <div className={styles.conf}>
        <span className={styles.confLabel}>Conf</span>
        <span className={styles.confValue}>{conf}</span>
      </div>
      <span className={cx(styles.badge, badgeClass)}>{verdictLabel(verdict)}</span>

      {/* Conditional rendering: `{cond && <JSX/>}` renders the JSX only
          when `cond` is truthy — a common React idiom. */}
      {verdict === "disputed" && dispute && (
        <div className={styles.dispute}>
          <span className={styles.disputeLabel}>{dispute.kind}</span>
          <span className={styles.disputeDetail}>{disputeDetail(dispute)}</span>
        </div>
      )}
    </div>
  );
}
