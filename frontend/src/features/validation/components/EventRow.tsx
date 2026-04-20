/**
 * EventRow — one primary-detector event line inside EventsPanel.
 *
 * Split out of EventsPanel.tsx as part of DV1 (frontend audit
 * 2026-04-20): the panel now only handles list controls + iteration,
 * and this component owns the per-row presentation. Uses the shared
 * EventsPanel.module.css stylesheet so DOM + classNames stay
 * byte-identical to the pre-split output.
 */
import { cx } from "../../../shared/lib/cx";
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

import styles from "./EventsPanel.module.css";

export interface EventRowProps {
  ev: SafetyEvent;
  verdict: Verdict;
  dispute?: DisputeInfo;
  onClick?: () => void;
}

export function EventRow({ ev, verdict, dispute, onClick }: EventRowProps) {
  const risk = ev.risk_level;
  const objects = formatObjects(ev.objects);
  const conf = formatConfidencePct(ev.confidence);

  const badgeClass =
    verdict === "verified"
      ? styles.badgeVerified
      : verdict === "disputed"
        ? styles.badgeDisputed
        : styles.badgePending;

  return (
    <div
      className={cx(styles.row, styles[risk], onClick && styles.rowClickable)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
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

      {verdict === "disputed" && dispute && (
        <div className={styles.dispute}>
          <span className={styles.disputeLabel}>{dispute.kind}</span>
          <span className={styles.disputeDetail}>{disputeDetail(dispute)}</span>
        </div>
      )}
    </div>
  );
}
