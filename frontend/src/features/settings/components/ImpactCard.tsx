/**
 * ImpactCard — before/after deltas + ops + severity bars + recommendation.
 *
 * Summarises what the pending/applied setting changes are doing to the
 * system: event rate, confidence, TTC percentile, sample size, severity
 * mix, and an overall "apply / rollback / monitor" recommendation plus a
 * narrative explanation.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: the impact card on the right column showing the predicted
 *   change in alert volume (with severity bars and ops deltas inside).
 * Backend: GET /api/settings/impact (via the useImpact hook) — returns
 *   a baseline + after_window + deltas + recommendation narrative. The
 *   card re-fetches every 5s plus on manual Refresh.
 */
import { useUptimeTicker } from "../../../shared/hooks/useUptimeTicker";
import { fmt, humanize, metricLabel, reasonLabel, tierClass } from "../utils/formatting";
import type { ImpactReport } from "../types";

import { OpsDeltas } from "./OpsDeltas";
import { SeverityBars } from "./SeverityBars";

import styles from "../SettingsPage.module.css";

interface ImpactCardProps {
  report: ImpactReport | null;
  refreshing: boolean;
  lastUpdatedTs: number | null;
  onRefresh: () => void;
}

/**
 * Render the Impact card.
 *
 * Parent: SettingsPage — owns the `useImpact` query, passes the report
 *   and a refresh callback down.
 * Children: OpsDeltas (fps/CPU/latency rows) and SeverityBars (stacked
 *   severity counts).
 * BE: indirect — renders the shape of GET /api/settings/impact.
 *
 * Renders a small placeholder card until the backend starts returning an
 * impact report (first apply or first baseline capture).
 */
export function ImpactCard({ report: r, refreshing, lastUpdatedTs, onRefresh }: ImpactCardProps) {
  // Tick once a second so the "Xs ago" label stays live between polls.
  // `lastUpdatedTs` is epoch-millis; convert to the unix-seconds shape
  // useUptimeTicker expects so the hook's "seconds since" math matches
  // the old `Math.round((Date.now() - lastUpdatedTs) / 1000)` output.
  const tickSeed = lastUpdatedTs === null ? null : lastUpdatedTs / 1000;
  const ticker = useUptimeTicker(tickSeed);
  const ago = lastUpdatedTs === null ? null : ticker;

  if (!r) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>Impact</h3>
        </div>
        <p className={styles.subtle} style={{ margin: 0 }}>
          No active session yet. Apply a change or capture a baseline.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Impact ({humanize(r.state)})</h3>
        <span className={`${styles.confidenceTier} ${tierClass(r.confidence_tier)}`}>
          {humanize(r.confidence_tier)}
        </span>
      </div>

      {r.changed_keys.length > 0 && (
        <div className={styles.subtle} style={{ fontSize: 11 }}>
          {r.changed_keys.length} key{r.changed_keys.length === 1 ? "" : "s"} changed:{" "}
          {r.changed_keys.slice(0, 2).map(humanize).join(", ")}
          {r.changed_keys.length > 2 ? "…" : ""}
        </div>
      )}

      {r.confidence_reasons.length > 0 && (
        <div className={styles.reasonList}>
          {r.confidence_reasons.map((reason) => (
            <span key={reason} className={styles.reasonChip} title={reason}>
              {reasonLabel(reason)}
            </span>
          ))}
        </div>
      )}

      {/* Three-column grid: metric label, before→after values, % delta.
          Delta colouring is hand-picked per metric because "up is bad"
          vs "up is good" depends on what the metric means:
            - event_rate UP   → deltaNeg (noisier alerts)
            - confidence_p50 UP → deltaPos (we trust events more)
            - ttc_p95 UP      → deltaPos (more headroom before impact)
          sample_size has no delta cell — it's raw counts, not a ratio. */}
      {r.baseline && r.after_window && (
        <>
          <div className={styles.deltaList}>
            <span>{metricLabel("event_rate_per_min")}</span>
            <span>
              {fmt(r.baseline.event_rate_per_min)} → {fmt(r.after_window.event_rate_per_min)}
            </span>
            <span
              className={(r.deltas.event_rate_per_min ?? 0) > 0 ? styles.deltaNeg : styles.deltaPos}
            >
              {fmt(r.deltas.event_rate_per_min, 1)}%
            </span>

            <span>{metricLabel("confidence_p50")}</span>
            <span>
              {fmt(r.baseline.confidence_p50)} → {fmt(r.after_window.confidence_p50)}
            </span>
            <span
              className={(r.deltas.confidence_p50 ?? 0) > 0 ? styles.deltaPos : styles.deltaNeg}
            >
              {fmt(r.deltas.confidence_p50, 1)}%
            </span>

            <span>{metricLabel("ttc_p95")}</span>
            <span>
              {fmt(r.baseline.ttc_p95)} → {fmt(r.after_window.ttc_p95)}
            </span>
            <span className={(r.deltas.ttc_p95 ?? 0) > 0 ? styles.deltaPos : styles.deltaNeg}>
              {fmt(r.deltas.ttc_p95, 1)}%
            </span>

            <span>{metricLabel("sample_size")}</span>
            <span>
              {r.baseline.sample_size} → {r.after_window.sample_size}
            </span>
            <span></span>
          </div>

          <OpsDeltas baseline={r.baseline} after={r.after_window} deltas={r.deltas} />

          <SeverityBars label="Severity (after-change)" counts={r.after_window.severity_counts} />
        </>
      )}

      {/* Narrative line: uppercase recommendation (APPLY / ROLLBACK /
          MONITOR — "monitor" is the safe default if the BE omits it)
          followed by a one-line explanation from the impact service. */}
      {r.narrative && (
        <div className={styles.narrative}>
          <strong>{(r.recommendation ?? "monitor").toUpperCase()}</strong>: {r.narrative}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" className={styles.btn} onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <span className={styles.subtle} style={{ fontSize: 11 }}>
          auto · every 5s{ago !== null ? ` · updated ${ago}s ago` : ""}
        </span>
      </div>

      {r.lagging_metrics.length > 0 && (
        <div className={styles.subtle} style={{ fontSize: 10 }}>
          Lagging metrics ({r.lagging_metrics.map(metricLabel).join(", ")}) need operator feedback
          before they populate.
        </div>
      )}
    </div>
  );
}
