/**
 * MonitoringPage — watchdog incident queue.
 *
 * Route binding:
 *   Rendered by <Route path="/monitoring" element={<MonitoringPage/>} />
 *   in frontend/src/App.tsx.
 *
 * What the user sees (plain English):
 *   - A header with a title, a "Select" button (multi-select mode toggle) and
 *     a "Clear All" button.
 *   - Four filter tiles (Errors / Warnings / Info / Incidents) — click one to
 *     narrow the list, click again to clear the filter.
 *   - A meta row summarising watchdog runs + interval.
 *   - Optional "Immediate Actions" strip — the top 3 non-info incidents with
 *     click-to-scroll anchor behaviour.
 *   - A grouped incident feed: each card shows title, severity, evidence
 *     chips, "What To Check" steps, debug commands, and a runbook line.
 *   - In select mode, the cards become checkable and a bulk-delete bar appears.
 *
 * Hooks called:
 *   - useEventStream()   → { connected }      — connection dot in TopBar.
 *     See hooks/useEventStream.ts.
 *   - useLiveStatus()    → { data: liveStatus } — source label.
 *     See hooks/useLiveStatus.ts.
 *   - useWatchdogCtx()   → { status, findings, deleteFindings, clearAll }
 *     Reads from the React Context defined in hooks/WatchdogContext.tsx,
 *     which in turn polls the watchdog API. Consuming a context means this
 *     component re-renders when the provider publishes new values.
 *   - useState / useMemo / useCallback for local UI state and stable handlers.
 *
 * Child components composed here:
 *   - components/layout/TopBar.tsx — page chrome.
 *   - A local <FilterTile/> helper (defined at the bottom of this file).
 *   No other subcomponents — MonitoringPage owns all of its markup inline.
 *
 * React concepts demonstrated:
 *   - Pure helper functions outside the component (findingKey, incidentId,
 *     formatTimestamp, formatRelative, buildIncidents) — allowed because they
 *     have no React state; keep them outside so they aren't re-created per
 *     render.
 *   - Context consumption (useWatchdogCtx) as an alternative to prop drilling.
 *   - useMemo to cache expensive derivations (grouping N findings into M
 *     incidents happens on every render otherwise).
 *   - useCallback to stabilise handler identity across renders (helps children
 *     that are React.memo'd and lets handlers be safely listed in effect deps).
 *   - Set-based selection state (a `Set<string>` held inside useState).
 *   - Conditional rendering: select-mode chrome, empty list, optional card
 *     subsections (evidence / steps / commands / runbook).
 *   - List rendering with `key`, including `index` + `incident.id` composite
 *     keys for nested lists where items have no stable id.
 *   - Event propagation control: `e.stopPropagation()` prevents a child button
 *     click from also triggering the parent card's click handler.
 *   - CSS Modules with template-string class composition
 *     (`${styles.a} ${styles[b]}`) for conditional/variant styling.
 *   - A local functional component (`FilterTile`) with a typed props object.
 *
 * Page-specific mechanics:
 *   - Incident filtering: `filter` is a discriminated string ("all"|"error"|…);
 *     `toggle` flips the active filter or resets to "all" when re-clicked.
 *   - Selection state: `selected: Set<string>` holds incident ids in select
 *     mode. `toggleSelect` uses the functional setter form to derive the next
 *     Set from the previous one (never mutate state in place).
 *   - Drawer expand/collapse: there's no literal drawer here, but the
 *     `selectMode` boolean toggles a selection bar at the top and morphs each
 *     card to show a checkbox (see the className string composition).
 *   - Scroll-to anchor: the "Immediate Actions" buttons call
 *     document.getElementById(...).scrollIntoView() — a rare escape hatch out
 *     of React's declarative model, used here because we only need to scroll
 *     the page, not update state.
 */

// TEACH: Same hook trio as the other pages, plus `useCallback` — which
// caches a function reference so long as its deps don't change. This is the
// function-shaped cousin of `useMemo`.
import { useCallback, useMemo, useState } from "react";
import { TopBar } from "../components/layout/TopBar";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useEventStream } from "../hooks/useEventStream";
import { useWatchdogCtx } from "../hooks/WatchdogContext";
import type { WatchdogFinding } from "../types";
// TEACH: CSS Modules. See MonitoringPage.module.css for class definitions.
import styles from "./MonitoringPage.module.css";

// TEACH: Module-level constants — computed once when the file loads, shared
// by every render. Place pure constants and helpers outside the component.
const SEV_ICON: Record<string, string> = { error: "!!", warning: "!", info: "i" };
const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

// TEACH: TypeScript string-literal union — `SevFilter` is the type of values
// that can only be one of these four strings. The compiler won't let us pass
// a random string into the filter state.
type SevFilter = "all" | "error" | "warning" | "info";

// A grouped incident record — many `WatchdogFinding`s roll up into one.
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

// --- Pure helpers (no React here — regular functions, no hooks) ---

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

// Group raw findings into incidents. Pure function of its input — no hooks.
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
  // --- Hooks ---
  const { connected } = useEventStream();
  const { data: liveStatus } = useLiveStatus();
  // TEACH: `useWatchdogCtx` reads React Context set up in WatchdogContext.tsx.
  // Context is the standard way to share state without prop-drilling — any
  // descendant of the provider can call this hook and gets live updates.
  const { status, findings, deleteFindings, clearAll } = useWatchdogCtx();

  // Local UI state for filtering and selection mode.
  const [filter, setFilter] = useState<SevFilter>("all");
  const [selectMode, setSelectMode] = useState(false);
  // TEACH: Holding a Set in useState. React's equality check is reference
  // equality (===), so every update MUST allocate a new Set — never mutate
  // and re-set the same reference, or React will skip the re-render.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // --- Derived state ---
  // TEACH: Grouping findings into incidents is O(N). useMemo caches the
  // result until `findings` changes, avoiding rework every keystroke/tick.
  const incidents = useMemo(() => buildIncidents(findings ?? []), [findings]);
  const filtered = useMemo(
    () => (filter === "all" ? incidents : incidents.filter((item) => item.severity === filter)),
    [filter, incidents],
  );

  // Plain derived values — cheap; no need to useMemo.
  const errors = incidents.filter((item) => item.severity === "error").length;
  const warnings = incidents.filter((item) => item.severity === "warning").length;
  const infos = incidents.filter((item) => item.severity === "info").length;
  const totalIncidents = incidents.length;
  const repeatingIncidents = incidents.filter((item) => item.count > 1).length;
  const actionQueue = filtered.filter((item) => item.severity !== "info").slice(0, 3);

  // --- Handlers ---
  // TEACH: Functional setter form — `prev => next`. Always use it when the
  // next value depends on the previous one, to avoid stale-closure bugs when
  // multiple updates happen in the same tick.
  const toggle = (sev: SevFilter) => setFilter((prev) => (prev === sev ? "all" : sev));

  // TEACH: `useCallback` caches the function so long as its deps don't change.
  // Empty deps [] here means "this function reference is stable for the
  // lifetime of the component". That matters when passed to React.memo'd
  // children or used in effect deps.
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const toggleSelect = useCallback((key: string) => {
    // TEACH: To "update" an immutable Set, copy it, mutate the copy, return.
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

  // TEACH: Async event handler. `useCallback` still returns a stable-ish
  // reference keyed on its deps. Note the try/finally — `setDeleting(false)`
  // runs regardless of whether the awaited call throws.
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

  // --- Render ---
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
              {/* TEACH: `&&` short-circuit — render the Select button only
                  when we're not already in select mode AND there is at least
                  one visible incident. */}
              {!selectMode && filtered.length > 0 && (
                <button className={styles.actionBtn} onClick={() => setSelectMode(true)}>
                  Select
                </button>
              )}
              {!selectMode && totalIncidents > 0 && (
                <button
                  // TEACH: Template-string class composition — combining a base
                  // class with a variant class. Works because `styles.foo` is
                  // just a string.
                  className={`${styles.actionBtn} ${styles.clearBtn}`}
                  onClick={handleClearAll}
                  disabled={deleting}
                >
                  {/* Ternary for button label during async work. */}
                  {deleting ? "Clearing…" : "Clear All"}
                </button>
              )}
            </div>
          </div>

          {/* Summary tiles — local <FilterTile/> component defined below. */}
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

        {/* Multi-select action bar — only visible in select mode. */}
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
          {/* Immediate Actions strip — top 3 urgent incidents. */}
          {actionQueue.length > 0 && (
            <section className={styles.queueSection}>
              <div className={styles.sectionHeader}>Immediate Actions</div>
              <div className={styles.queueGrid}>
                {/* TEACH: .map over urgent incidents. `key` is incident.id
                    which is stable (either fingerprint or category:title). */}
                {actionQueue.map((incident) => (
                  <button
                    key={incident.id}
                    className={`${styles.queueCard} ${styles[incident.severity]}`}
                    // TEACH: This handler escapes React's virtual DOM: it uses
                    // `document.getElementById` + `scrollIntoView` to jump the
                    // viewport to the same incident rendered below. Fine
                    // because we're only reading layout, not mutating app state.
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

          {/* Full incident feed. */}
          <section className={styles.feedSection}>
            <div className={styles.sectionHeader}>
              {/* Ternary for "all" vs specific-severity label. */}
              {filter === "all"
                ? `Showing ${filtered.length} incident groups`
                : `Showing ${filtered.length} ${filter} incident${filtered.length !== 1 ? "s" : ""}`}
            </div>

            {filtered.length === 0 && (
              <div className={styles.emptyList}>
                {/* Nested ternary — collapse if this becomes hard to read. */}
                {filter !== "all"
                  ? `No ${filter} incidents in the recent window`
                  : status?.run_count
                    ? "No active issues found in the recent window"
                    : "Waiting for the first watchdog check…"}
              </div>
            )}

            <div className={styles.incidentList}>
              {/* TEACH: Main list render. The callback returns a large JSX
                  subtree; using `{ ... return ... }` lets us compute locals
                  (`latest`, `isSelected`) before returning. */}
              {filtered.map((incident) => {
                const latest = incident.latest;
                const isSelected = selected.has(incident.id);
                return (
                  <article
                    // `id=` is a real DOM id used by the scrollIntoView above.
                    id={`incident-${incident.id}`}
                    // TEACH: Multi-class composition. `styles[incident.severity]`
                    // uses a computed property access — the JS value of
                    // `incident.severity` ("error" | "warning" | "info") is
                    // used as a key on the styles object.
                    className={`${styles.incidentCard} ${styles[incident.severity]} ${selectMode ? styles.selectable : ""} ${isSelected ? styles.selected : ""}`}
                    key={incident.id}
                    // TEACH: Conditional handler. `undefined` means "don't add
                    // an onClick at all", whereas a no-op function would still
                    // capture clicks. In select mode clicks toggle selection;
                    // otherwise the card is non-clickable.
                    onClick={selectMode ? () => toggleSelect(incident.id) : undefined}
                  >
                    <div className={styles.incidentHeader}>
                      <div className={styles.incidentHeaderLeft}>
                        {selectMode && (
                          <span className={`${styles.checkbox} ${isSelected ? styles.checked : ""}`}>
                            {/* Simple ternary for checkbox glyph. */}
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
                          // TEACH: `e.stopPropagation()` prevents this click
                          // from bubbling up to the parent <article>'s
                          // onClick. Without it, deleting would ALSO toggle
                          // selection when in select mode (though we're not
                          // in select mode here — defence in depth).
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
                          {/* Inline ternary producing a string, not JSX. */}
                          {latest.cause_confidence === "inferred" ? " (inferred)" : ""}
                        </span>
                        <p>{latest.likely_cause || "No likely cause attached yet."}</p>
                      </div>
                    </div>

                    {/* Optional sections — render only when the backend provided the data. */}
                    {latest.evidence && latest.evidence.length > 0 && (
                      <div className={styles.sectionBlock}>
                        <div className={styles.blockLabel}>Evidence</div>
                        <div className={styles.evidenceGrid}>
                          {/* TEACH: Nested list render. Evidence items don't
                              have their own stable id, so we build a composite
                              key from the incident id and array index. This is
                              safe ONLY because the list isn't reordered; it
                              just grows append-only per incident. */}
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

// TEACH: Local functional component — same rules as the page component. It
// receives `props` as its single argument; we destructure inline, and the
// TypeScript annotation `{ ... }: { ... }` documents the prop shape. Because
// it's declared in the same module, it's private to this page.
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
    // TEACH: Dynamic variant class — `styles[`t${variant}`]` picks the
    // `.terror`, `.twarning`, `.tinfo`, or `.ttotal` class by concatenating
    // the string "t" with the variant prop at render time.
    <button className={`${styles.tile} ${styles[`t${variant}`]} ${active ? styles.tileActive : ""}`} onClick={onClick}>
      <div className={styles.tLabel}>{label}</div>
      <div className={styles.tValue}>{value}</div>
    </button>
  );
}
