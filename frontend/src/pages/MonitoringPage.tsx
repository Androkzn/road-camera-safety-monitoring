import { useState, useCallback } from "react";
import { TopBar } from "../components/layout/TopBar";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useEventStream } from "../hooks/useEventStream";
import { useWatchdogCtx } from "../hooks/WatchdogContext";
import type { WatchdogFinding } from "../types";
import styles from "./MonitoringPage.module.css";

const SEV_ICON: Record<string, string> = { error: "!!", warning: "!", info: "i" };
const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

type SevFilter = "all" | "error" | "warning" | "info";

function findingKey(f: WatchdogFinding): string {
  return `${f.snapshot_id}_${f.ts}`;
}

export function MonitoringPage() {
  const { connected } = useEventStream();
  const { data: liveStatus } = useLiveStatus();
  const { status, findings, deleteFindings, clearAll } = useWatchdogCtx();

  const [filter, setFilter] = useState<SevFilter>("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const errors = status?.by_severity?.error ?? 0;
  const warnings = status?.by_severity?.warning ?? 0;
  const infos = status?.by_severity?.info ?? 0;
  const total = status?.total_findings ?? 0;
  const lastAgo = status?.last_run_ago_sec;

  const toggle = (sev: SevFilter) =>
    setFilter((prev) => (prev === sev ? "all" : sev));

  const allFindings = [...(findings ?? [])].sort((a, b) => {
    const d = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    return d !== 0 ? d : b.ts.localeCompare(a.ts);
  });

  const filtered =
    filter === "all"
      ? allFindings
      : allFindings.filter((f) => f.severity === filter);

  const byCategory: Record<string, WatchdogFinding[]> = {};
  for (const f of filtered) {
    const cat = f.category || "system";
    (byCategory[cat] ??= []).push(f);
  }

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelected(new Set(filtered.map(findingKey)));
  }, [filtered]);

  const handleDeleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      await deleteFindings(Array.from(selected));
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [deleteFindings, selected, exitSelectMode]);

  const handleClearAll = useCallback(async () => {
    setDeleting(true);
    try {
      await clearAll();
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [clearAll, exitSelectMode]);

  const sourceName = liveStatus?.source ?? "—";

  return (
    <>
      <TopBar sourceName={sourceName} connected={connected} />

      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <h1>Error Monitoring</h1>
            <div className={styles.headerActions}>
              {!selectMode && filtered.length > 0 && (
                <button
                  className={styles.actionBtn}
                  onClick={() => setSelectMode(true)}
                >
                  Select
                </button>
              )}
              {!selectMode && total > 0 && (
                <button
                  className={`${styles.actionBtn} ${styles.clearBtn}`}
                  onClick={handleClearAll}
                  disabled={deleting}
                >
                  {deleting ? "Clearing…" : "Clear All"}
                </button>
              )}
            </div>
          </div>

          <div className={styles.summaryGrid}>
            <FilterTile label="Errors" value={errors} variant="error" active={filter === "error"} onClick={() => toggle("error")} />
            <FilterTile label="Warnings" value={warnings} variant="warning" active={filter === "warning"} onClick={() => toggle("warning")} />
            <FilterTile label="Info" value={infos} variant="info" active={filter === "info"} onClick={() => toggle("info")} />
            <FilterTile label="Total" value={total} variant="total" active={filter === "all"} onClick={() => setFilter("all")} />
          </div>

          <div className={styles.meta}>
            <span>
              Checks: {status?.run_count ?? 0} | Interval:{" "}
              {status?.interval_sec ?? 60}s
            </span>
            <span>
              {lastAgo != null
                ? `Last check: ${Math.round(lastAgo)}s ago`
                : "Waiting…"}
            </span>
          </div>
        </div>

        {selectMode && (
          <div className={styles.selectionBar}>
            <div className={styles.selectionInfo}>
              <span>{selected.size} selected</span>
              <button className={styles.selBarBtn} onClick={selectAllVisible}>
                Select all ({filtered.length})
              </button>
              <button
                className={styles.selBarBtn}
                onClick={() => setSelected(new Set())}
              >
                Deselect all
              </button>
            </div>
            <div className={styles.selectionActions}>
              <button
                className={`${styles.selBarBtn} ${styles.deleteBtn}`}
                onClick={handleDeleteSelected}
                disabled={selected.size === 0 || deleting}
              >
                {deleting ? "Deleting…" : `Delete (${selected.size})`}
              </button>
              <button className={styles.selBarBtn} onClick={exitSelectMode}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className={styles.filterLabel}>
          {filter === "all"
            ? `Showing all ${filtered.length} findings`
            : `Showing ${filtered.length} ${filter}${filtered.length !== 1 ? "s" : ""}`}
        </div>

        <div className={styles.findingsGrid}>
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
              {items.map((f, i) => {
                const key = findingKey(f);
                const isSelected = selected.has(key);
                return (
                  <div
                    className={`${styles.findingItem} ${styles[f.severity]} ${selectMode ? styles.selectable : ""} ${isSelected ? styles.selected : ""}`}
                    key={`${f.snapshot_id}-${i}`}
                    onClick={selectMode ? () => toggleSelect(key) : undefined}
                  >
                    <div className={styles.findingTop}>
                      {selectMode && (
                        <span
                          className={`${styles.checkbox} ${isSelected ? styles.checked : ""}`}
                        >
                          {isSelected ? "✓" : ""}
                        </span>
                      )}
                      <span
                        className={`${styles.sevIcon} ${styles[f.severity]}`}
                      >
                        {SEV_ICON[f.severity] ?? "?"}
                      </span>
                      <span className={styles.findingTitle}>{f.title}</span>
                      <span className={styles.findingTs}>
                        {new Date(f.ts).toLocaleTimeString()}
                      </span>
                      {!selectMode && (
                        <button
                          className={styles.deleteSingle}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFindings([key]);
                          }}
                          title="Delete this finding"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                    <div className={styles.findingDetail}>{f.detail}</div>
                    {f.suggestion && (
                      <div className={styles.findingSuggestion}>
                        {f.suggestion}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
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
