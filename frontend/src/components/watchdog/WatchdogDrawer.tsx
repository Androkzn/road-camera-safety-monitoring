import { useState } from "react";
import type { WatchdogFinding, WatchdogStatus } from "../../types";
import styles from "./WatchdogDrawer.module.css";

const SEV_ICON: Record<string, string> = {
  error: "!!",
  warning: "!",
  info: "i",
};

const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

type SevFilter = "all" | "error" | "warning" | "info";

interface WatchdogDrawerProps {
  open: boolean;
  onClose: () => void;
  status: WatchdogStatus | null;
  findings: WatchdogFinding[] | null;
}

export function WatchdogDrawer({
  open,
  onClose,
  status,
  findings,
}: WatchdogDrawerProps) {
  const [filter, setFilter] = useState<SevFilter>("all");

  const errors = status?.by_severity?.error ?? 0;
  const warnings = status?.by_severity?.warning ?? 0;
  const infos = status?.by_severity?.info ?? 0;
  const total = status?.total_findings ?? 0;
  const lastAgo = status?.last_run_ago_sec;

  const toggle = (sev: SevFilter) => {
    setFilter((prev) => (prev === sev ? "all" : sev));
  };

  const allFindings = [...(findings ?? [])].sort((a, b) => {
    const sevDiff = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    return b.ts.localeCompare(a.ts);
  });

  const filtered =
    filter === "all"
      ? allFindings
      : allFindings.filter((f) => f.severity === filter);

  const byCategory: Record<string, WatchdogFinding[]> = {};
  for (const f of filtered) {
    const cat = f.category || "system";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(f);
  }

  return (
    <>
      <div
        className={`${styles.overlay} ${open ? styles.open : ""}`}
        onClick={onClose}
      />
      <aside className={`${styles.drawer} ${open ? styles.open : ""}`}>
        <div className={styles.head}>
          <h2>Error Monitoring</h2>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            &times;
          </button>
        </div>

        <div className={styles.summaryGrid}>
          <FilterTile label="Errors" value={errors} variant="error" active={filter === "error"} onClick={() => toggle("error")} />
          <FilterTile label="Warnings" value={warnings} variant="warning" active={filter === "warning"} onClick={() => toggle("warning")} />
          <FilterTile label="Info" value={infos} variant="info" active={filter === "info"} onClick={() => toggle("info")} />
          <FilterTile label="All" value={total} variant="total" active={filter === "all"} onClick={() => setFilter("all")} />
        </div>

        <div className={styles.meta}>
          <span>
            Checks: {status?.run_count ?? 0} |
            Interval: {status?.interval_sec ?? 60}s
          </span>
          <span>
            {lastAgo != null ? `Last check: ${Math.round(lastAgo)}s ago` : "Waiting…"}
          </span>
        </div>

        <div className={styles.filterLabel}>
          {filter === "all"
            ? `Showing all ${filtered.length} findings`
            : `Showing ${filtered.length} ${filter}${filtered.length !== 1 ? "s" : ""}`}
        </div>

        <div className={styles.findingsList}>
          {filtered.length === 0 && (
            <div className={styles.emptyList}>
              {filter !== "all"
                ? `No ${filter} findings`
                : status?.run_count
                  ? "No issues found — system healthy"
                  : "Waiting for first check…"}
            </div>
          )}
          {Object.entries(byCategory).map(([cat, items]) => (
            <div className={styles.catGroup} key={cat}>
              <div className={styles.catHeader}>{cat}</div>
              {items.map((f, i) => (
                <div
                  className={`${styles.findingItem} ${styles[f.severity]}`}
                  key={`${f.snapshot_id}-${i}`}
                >
                  <div className={styles.findingTop}>
                    <span className={`${styles.sevIcon} ${styles[f.severity]}`}>
                      {SEV_ICON[f.severity] ?? "?"}
                    </span>
                    <span className={styles.findingTitle}>{f.title}</span>
                    <span className={styles.findingTs}>
                      {new Date(f.ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className={styles.findingDetail}>{f.detail}</div>
                  {f.suggestion && (
                    <div className={styles.findingSuggestion}>{f.suggestion}</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

function FilterTile({
  label,
  value,
  variant,
  active,
  onClick,
}: {
  label: string;
  value: number | string;
  variant: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`${styles.tile} ${styles[`t${variant}`]} ${active ? styles.tileActive : ""}`}
      onClick={onClick}
    >
      <div className={styles.tLabel}>{label}</div>
      <div className={styles.tValue}>{value || "—"}</div>
    </div>
  );
}
