import { useCallback, useMemo, useState } from "react";
import { TopBar } from "../components/layout/TopBar";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useEventStream } from "../hooks/useEventStream";
import { useWatchdogCtx } from "../hooks/WatchdogContext";
import type { WatchdogFinding } from "../types";
import styles from "./MonitoringPage.module.css";

const SEV_ICON: Record<string, string> = { error: "!!", warning: "!", info: "i" };
const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

type SevFilter = "all" | "error" | "warning" | "info";

type WatchdogIncident = {
  id: string;
  fingerprint: string;
  severity: "error" | "warning" | "info";
  category: string;
  title: string;
  owner?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  rawKeys: string[];
  latest: WatchdogFinding;
};

function findingKey(f: WatchdogFinding): string {
  return `${f.snapshot_id}_${f.ts}`;
}

function incidentId(f: WatchdogFinding): string {
  return f.fingerprint || `${f.category}:${f.title}`;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(ts: string): string {
  const target = new Date(ts).getTime();
  if (Number.isNaN(target)) return ts;
  const diffSec = Math.max(0, Math.round((Date.now() - target) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function getEvidenceClass(status?: string): string {
  if (status === "breach") return styles.evidenceBreach ?? "";
  if (status === "trend") return styles.evidenceTrend ?? "";
  return styles.evidenceContext ?? "";
}

function buildIncidents(items: WatchdogFinding[]): WatchdogIncident[] {
  const groups = new Map<string, WatchdogIncident>();

  for (const finding of items) {
    const id = incidentId(finding);
    const key = findingKey(finding);
    const existing = groups.get(id);

    if (!existing) {
      groups.set(id, {
        id,
        fingerprint: finding.fingerprint || id,
        severity: finding.severity,
        category: finding.category || "system",
        title: finding.title,
        owner: finding.owner,
        count: 1,
        firstSeen: finding.ts,
        lastSeen: finding.ts,
        rawKeys: [key],
        latest: finding,
      });
      continue;
    }

    existing.count += 1;
    existing.rawKeys.push(key);

    if ((SEV_ORDER[finding.severity] ?? 9) < (SEV_ORDER[existing.severity] ?? 9)) {
      existing.severity = finding.severity;
    }
    if (new Date(finding.ts).getTime() < new Date(existing.firstSeen).getTime()) {
      existing.firstSeen = finding.ts;
    }
    if (new Date(finding.ts).getTime() >= new Date(existing.lastSeen).getTime()) {
      existing.lastSeen = finding.ts;
      existing.latest = finding;
      existing.category = finding.category || existing.category;
      existing.title = finding.title || existing.title;
      existing.owner = finding.owner || existing.owner;
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    const sev = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    if (sev !== 0) return sev;
    const pri = (b.latest.priority_score ?? 0) - (a.latest.priority_score ?? 0);
    if (pri !== 0) return pri;
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeen.localeCompare(a.lastSeen);
  });
}

export function MonitoringPage() {
  const { connected } = useEventStream();
  const { data: liveStatus } = useLiveStatus();
  const { status, findings, deleteFindings, clearAll } = useWatchdogCtx();

  const [filter, setFilter] = useState<SevFilter>("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const incidents = useMemo(() => buildIncidents(findings ?? []), [findings]);
  const filtered = useMemo(
    () => (filter === "all" ? incidents : incidents.filter((item) => item.severity === filter)),
    [filter, incidents],
  );

  const errors = incidents.filter((item) => item.severity === "error").length;
  const warnings = incidents.filter((item) => item.severity === "warning").length;
  const infos = incidents.filter((item) => item.severity === "info").length;
  const totalIncidents = incidents.length;
  const repeatingIncidents = incidents.filter((item) => item.count > 1).length;
  const actionQueue = filtered.filter((item) => item.severity !== "info").slice(0, 3);

  const toggle = (sev: SevFilter) => setFilter((prev) => (prev === sev ? "all" : sev));

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
    setSelected(new Set(filtered.map((item) => item.id)));
  }, [filtered]);

  const handleDeleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const keys = filtered
        .filter((item) => selected.has(item.id))
        .flatMap((item) => item.rawKeys);
      await deleteFindings(Array.from(new Set(keys)));
      exitSelectMode();
    } finally {
      setDeleting(false);
    }
  }, [deleteFindings, exitSelectMode, filtered, selected]);

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
  const lastAgo = status?.last_run_ago_sec;

  return (
    <>
      <TopBar sourceName={sourceName} connected={connected} />

      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <div>
              <h1>Error Monitoring</h1>
              <p className={styles.subtitle}>
                Grouped into actionable incidents with impact, evidence, and next debugging moves.
              </p>
            </div>
            <div className={styles.headerActions}>
              {!selectMode && filtered.length > 0 && (
                <button className={styles.actionBtn} onClick={() => setSelectMode(true)}>
                  Select
                </button>
              )}
              {!selectMode && totalIncidents > 0 && (
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
            <FilterTile label="Incidents" value={totalIncidents} variant="total" active={filter === "all"} onClick={() => setFilter("all")} />
          </div>

          <div className={styles.metaGrid}>
            <div className={styles.metaCard}>
              <span className={styles.metaLabel}>Watchdog</span>
              <strong>{status?.run_count ?? 0} runs</strong>
              <span>{lastAgo != null ? `Last check ${Math.round(lastAgo)}s ago` : "Waiting for first check"}</span>
            </div>
            <div className={styles.metaCard}>
              <span className={styles.metaLabel}>Active Queue</span>
              <strong>{filtered.length} visible incidents</strong>
              <span>{repeatingIncidents} repeating in the recent window</span>
            </div>
            <div className={styles.metaCard}>
              <span className={styles.metaLabel}>Cadence</span>
              <strong>{status?.interval_sec ?? 60}s interval</strong>
              <span>Grouped by incident fingerprint, not raw line count</span>
            </div>
          </div>
        </div>

        {selectMode && (
          <div className={styles.selectionBar}>
            <div className={styles.selectionInfo}>
              <span>{selected.size} incident groups selected</span>
              <button className={styles.selBarBtn} onClick={selectAllVisible}>
                Select all ({filtered.length})
              </button>
              <button className={styles.selBarBtn} onClick={() => setSelected(new Set())}>
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

        <div className={styles.content}>
          {actionQueue.length > 0 && (
            <section className={styles.queueSection}>
              <div className={styles.sectionHeader}>Immediate Actions</div>
              <div className={styles.queueGrid}>
                {actionQueue.map((incident) => (
                  <button
                    key={incident.id}
                    className={`${styles.queueCard} ${styles[incident.severity]}`}
                    onClick={() => {
                      const el = document.getElementById(`incident-${incident.id}`);
                      el?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    <span className={styles.queueSeverity}>{incident.severity.toUpperCase()}</span>
                    <span className={styles.queueTitle}>{incident.title}</span>
                    <span className={styles.queueNext}>{incident.latest.suggestion || incident.latest.detail}</span>
                    <span className={styles.queueMeta}>
                      {incident.owner || incident.category} • last seen {formatRelative(incident.lastSeen)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className={styles.feedSection}>
            <div className={styles.sectionHeader}>
              {filter === "all"
                ? `Showing ${filtered.length} incident groups`
                : `Showing ${filtered.length} ${filter} incident${filtered.length !== 1 ? "s" : ""}`}
            </div>

            {filtered.length === 0 && (
              <div className={styles.emptyList}>
                {filter !== "all"
                  ? `No ${filter} incidents in the recent window`
                  : status?.run_count
                    ? "No active issues found in the recent window"
                    : "Waiting for the first watchdog check…"}
              </div>
            )}

            <div className={styles.incidentList}>
              {filtered.map((incident) => {
                const latest = incident.latest;
                const isSelected = selected.has(incident.id);
                return (
                  <article
                    id={`incident-${incident.id}`}
                    className={`${styles.incidentCard} ${styles[incident.severity]} ${selectMode ? styles.selectable : ""} ${isSelected ? styles.selected : ""}`}
                    key={incident.id}
                    onClick={selectMode ? () => toggleSelect(incident.id) : undefined}
                  >
                    <div className={styles.incidentHeader}>
                      <div className={styles.incidentHeaderLeft}>
                        {selectMode && (
                          <span className={`${styles.checkbox} ${isSelected ? styles.checked : ""}`}>
                            {isSelected ? "✓" : ""}
                          </span>
                        )}
                        <span className={`${styles.sevIcon} ${styles[incident.severity]}`}>
                          {SEV_ICON[incident.severity] ?? "?"}
                        </span>
                        <div className={styles.incidentTitleBlock}>
                          <div className={styles.incidentTitleRow}>
                            <h2 className={styles.incidentTitle}>{incident.title}</h2>
                            <div className={styles.metaPills}>
                              <span className={styles.pill}>{incident.category}</span>
                              {incident.owner && <span className={styles.pill}>{incident.owner}</span>}
                              {incident.count > 1 && <span className={`${styles.pill} ${styles.repeatPill}`}>Seen {incident.count}x</span>}
                              {latest.source === "ai" && <span className={`${styles.pill} ${styles.aiPill}`}>AI hypothesis</span>}
                            </div>
                          </div>
                          <div className={styles.incidentTimeline}>
                            <span>First seen {formatTimestamp(incident.firstSeen)}</span>
                            <span>Last seen {formatTimestamp(incident.lastSeen)} ({formatRelative(incident.lastSeen)})</span>
                          </div>
                        </div>
                      </div>
                      {!selectMode && (
                        <button
                          className={styles.deleteSingle}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFindings(incident.rawKeys);
                          }}
                          title="Delete this incident group"
                        >
                          &times;
                        </button>
                      )}
                    </div>

                    <div className={styles.nextStepBox}>
                      <span className={styles.nextStepLabel}>Next move</span>
                      <strong>{latest.suggestion || "Inspect the evidence attached to this incident."}</strong>
                    </div>

                    <div className={styles.summaryPanel}>
                      <div className={styles.summaryCard}>
                        <span className={styles.summaryLabel}>Observed</span>
                        <p>{latest.detail}</p>
                      </div>
                      <div className={styles.summaryCard}>
                        <span className={styles.summaryLabel}>Impact</span>
                        <p>{latest.impact || "Impact not provided for this incident yet."}</p>
                      </div>
                      <div className={styles.summaryCard}>
                        <span className={styles.summaryLabel}>
                          Likely Cause
                          {latest.cause_confidence === "inferred" ? " (inferred)" : ""}
                        </span>
                        <p>{latest.likely_cause || "No likely cause attached yet."}</p>
                      </div>
                    </div>

                    {latest.evidence && latest.evidence.length > 0 && (
                      <div className={styles.sectionBlock}>
                        <div className={styles.blockLabel}>Evidence</div>
                        <div className={styles.evidenceGrid}>
                          {latest.evidence.map((item, index) => (
                            <div
                              className={`${styles.evidenceChip} ${getEvidenceClass(item.status)}`}
                              key={`${incident.id}-evidence-${index}`}
                            >
                              <span className={styles.evidenceLabel}>{item.label}</span>
                              <strong className={styles.evidenceValue}>{item.value}</strong>
                              {item.threshold && <span className={styles.evidenceThreshold}>Target {item.threshold}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {latest.investigation_steps && latest.investigation_steps.length > 0 && (
                      <div className={styles.sectionBlock}>
                        <div className={styles.blockLabel}>What To Check</div>
                        <ol className={styles.stepsList}>
                          {latest.investigation_steps.map((step, index) => (
                            <li key={`${incident.id}-step-${index}`}>{step}</li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {latest.debug_commands && latest.debug_commands.length > 0 && (
                      <div className={styles.sectionBlock}>
                        <div className={styles.blockLabel}>Fast Debug Paths</div>
                        <div className={styles.commandsList}>
                          {latest.debug_commands.map((command, index) => (
                            <code className={styles.commandChip} key={`${incident.id}-cmd-${index}`}>
                              {command}
                            </code>
                          ))}
                        </div>
                      </div>
                    )}

                    {latest.runbook && <div className={styles.runbook}>Playbook: {latest.runbook}</div>}
                  </article>
                );
              })}
            </div>
          </section>
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
    <button className={`${styles.tile} ${styles[`t${variant}`]} ${active ? styles.tileActive : ""}`} onClick={onClick}>
      <div className={styles.tLabel}>{label}</div>
      <div className={styles.tValue}>{value}</div>
    </button>
  );
}
