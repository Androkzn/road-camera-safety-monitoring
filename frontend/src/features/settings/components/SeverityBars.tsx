/**
 * SeverityBars — stacked horizontal bars for severity counts.
 *
 * Bars are proportionally sized against the sum of all counts so the
 * widest bar corresponds to the most-common severity in the window.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: the small severity bar chart inside the impact card
 *   (one row per severity: high / medium / low / unknown).
 *
 * Backend: none directly. Consumes the `severity_counts` slice of
 *   GET /api/settings/impact via the parent ImpactCard.
 */
import { severityLabel } from "../utils/formatting";

import styles from "../SettingsPage.module.css";

interface SeverityBarsProps {
  label: string;
  counts: Record<string, number>;
}

/**
 * Render the severity bar chart.
 *
 * Parent: ImpactCard. Children: none (just flex rows).
 * BE: indirect — renders the `severity_counts` dict verbatim.
 *
 * Ordering rule: render canonical severities in fixed order
 * (high → medium → low → unknown), then append any unrecognised keys
 * afterwards. This keeps the visual rank stable across windows even if
 * the backend adds new severity buckets later.
 */
export function SeverityBars({ label, counts }: SeverityBarsProps) {
  // Divide-by-zero guard: if every bucket is zero, fall back to 1 so
  // the `(v / total) * 100` math below is still well-defined (and all
  // bars render at 0% width).
  const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
  const order = ["high", "medium", "low", "unknown"];
  // Track which canonical keys we've already emitted, so the trailing
  // "unknown-schema" loop below can pick up anything new without dupes.
  const seen = new Set<string>();
  return (
    <div>
      <div className={styles.subtle} style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div className={styles.bars}>
        {order
          .filter((k) => counts[k] != null)
          .map((k) => {
            seen.add(k);
            const v = counts[k] ?? 0;
            return (
              <div className={styles.barRow} key={k}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>{severityLabel(k)}</div>
                  <div className={styles.bar}>
                    <div className={styles.barFill} style={{ width: `${(v / total) * 100}%` }} />
                  </div>
                </div>
                <span className={styles.subtle}>{v}</span>
              </div>
            );
          })}
        {/* Tail pass: render any severities that weren't in the canonical
            order list so unexpected BE values still show up instead of
            being silently dropped. */}
        {Object.entries(counts)
          .filter(([k]) => !seen.has(k))
          .map(([k, v]) => (
            <div className={styles.barRow} key={k}>
              <div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>{severityLabel(k)}</div>
                <div className={styles.bar}>
                  <div className={styles.barFill} style={{ width: `${(v / total) * 100}%` }} />
                </div>
              </div>
              <span className={styles.subtle}>{v}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
