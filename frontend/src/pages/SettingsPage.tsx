/**
 * SettingsPage — operator-facing tuning console.
 *
 * Layout (works at any width):
 *   [TopBar]
 *   ┌─────────────────────────────┬──────────────────┐
 *   │ Page header                 │ Templates        │
 *   │ Validation errors / warns   │ Baseline         │
 *   │ <details> per category      │ Impact           │
 *   │   tunable rows…             │ (Live preview,   │
 *   │ [sticky apply bar]          │  collapsed)      │
 *   └─────────────────────────────┴──────────────────┘
 *
 * Below 1100px the right rail wraps under the tunables column so we never
 * get horizontal overflow or a hidden settings panel.
 */

import { useEffect, useMemo, useState } from "react";

import { TopBar } from "../components/layout/TopBar";
import { useAdminToken } from "../hooks/useAdminToken";
import { useImpact } from "../hooks/useImpact";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useSettings } from "../hooks/useSettings";
import { useSettingsTemplates } from "../hooks/useSettingsTemplates";
import {
  type AdminApiError,
  MissingAdminTokenError,
  adminFetch,
} from "../lib/adminApi";
import type {
  ApplyResultPayload,
  ConfidenceTier,
  ImpactReport,
  SettingSpec,
  SettingsTemplate,
} from "../types";

import styles from "./SettingsPage.module.css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type DraftValue = number | string | boolean;

function isPrivacyConfirmRequired(exc: unknown): boolean {
  return (
    !!exc &&
    typeof exc === "object" &&
    (exc as AdminApiError).status === 400 &&
    (exc as AdminApiError).body !== null &&
    typeof (exc as AdminApiError).body === "object" &&
    ((exc as AdminApiError).body as { error?: string }).error === "privacy_confirm_required"
  );
}

function extractValidationErrors(exc: unknown): Array<{ key: string; reason: string }> | null {
  if (
    exc &&
    typeof exc === "object" &&
    (exc as AdminApiError).status === 422 &&
    (exc as AdminApiError).body !== null &&
    typeof (exc as AdminApiError).body === "object"
  ) {
    const body = (exc as AdminApiError).body as { errors?: Array<{ key: string; reason: string }> };
    return body.errors ?? null;
  }
  return null;
}

function tierClass(tier: ConfidenceTier): string {
  switch (tier) {
    case "high": return styles.tierHigh ?? "";
    case "medium": return styles.tierMedium ?? "";
    case "low": return styles.tierLow ?? "";
    default: return styles.tierInsufficient ?? "";
  }
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v).toFixed(digits);
}

/**
 * Pick a clean step for a numeric tunable. Honours an explicit ``spec.step``
 * when set; otherwise picks the largest "nice" increment (1, 0.5, 0.1,
 * 0.05, 0.01, …) that yields at least 20 slider stops over the range. This
 * keeps the slider responsive without producing values like ``5.0125``.
 */
function stepFor(spec: SettingSpec, min: number, max: number): number {
  if (spec.step != null && spec.step > 0) return spec.step;
  if (spec.type === "int") return 1;
  const range = Math.max(max - min, 0.0001);
  const candidates = [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01];
  for (const c of candidates) {
    if (range / c >= 20) return c;
  }
  return 0.01;
}

/** Acronyms we want to keep uppercase when humanizing SCREAMING_SNAKE keys. */
const ACRONYMS = new Set([
  "TTC", "ALPR", "LLM", "FPS", "BBOX", "CB", "CONF",
  "MIN", "MAX", "SEC", "DIST", "ID", "PER",
]);

/**
 * Convert ``SOME_KEY_NAME`` (or ``some-thing``) to a human label, preserving
 * the acronyms in :data:`ACRONYMS`. E.g.
 *   ``MIN_BBOX_AREA``           → "MIN BBOX Area"
 *   ``VEHICLE_PAIR_CONF_FLOOR`` → "Vehicle Pair CONF Floor"
 *   ``risk-tier``               → "Risk Tier"
 */
function humanize(raw: string): string {
  return raw
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function shortSource(src: string): string {
  if (!src) return "—";
  if (/youtube\.com|youtu\.be/.test(src)) return "youtube";
  if (src.startsWith("http")) {
    try { return new URL(src).hostname.replace(/^www\./, ""); } catch { return src.slice(0, 24); }
  }
  const seg = src.split("/").filter(Boolean).pop();
  return seg || src;
}

// ---------------------------------------------------------------------------
// TunableControl
// ---------------------------------------------------------------------------
function TunableControl(props: {
  spec: SettingSpec;
  effective: DraftValue;
  draft: DraftValue;
  errorReason: string | null;
  onChange: (v: DraftValue) => void;
}) {
  const { spec, effective, draft, errorReason, onChange } = props;
  const dirty = draft !== effective;
  const cls = [
    styles.tunable,
    dirty ? styles.dirty : "",
    errorReason ? styles.error : "",
  ].filter(Boolean).join(" ");

  let control: React.ReactNode;
  if (spec.type === "enum" && spec.enum) {
    control = (
      <select value={String(draft)} onChange={(e) => onChange(e.target.value)}>
        {spec.enum.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  } else if (spec.type === "bool") {
    control = (
      <input type="checkbox" checked={!!draft} onChange={(e) => onChange(e.target.checked)} />
    );
  } else if (spec.type === "int" || spec.type === "float") {
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const step = stepFor(spec, min, max);
    const parse = (s: string) => {
      const n = spec.type === "int" ? parseInt(s, 10) : parseFloat(s);
      if (!Number.isFinite(n)) return spec.type === "int" ? 0 : 0;
      // Quantise to the chosen step so the displayed value never inherits
      // floating-point noise from the slider widget (e.g. 5.0125).
      const snapped = Math.round((n - min) / step) * step + min;
      // Round to the step's significant digits so we don't print 5.000000001.
      const digits = step >= 1 ? 0 : Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
      return Number(snapped.toFixed(digits));
    };
    control = (
      <>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) => onChange(parse(e.target.value))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) => onChange(parse(e.target.value))}
        />
      </>
    );
  } else {
    control = <input type="text" value={String(draft)} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className={cls}>
      <div className={styles.keyCol}>
        <span className={styles.keyLabel}>{humanize(spec.key)}</span>
        <span className={styles.keyName}>{spec.key}</span>
        <span className={styles.keyDesc}>{spec.description}</span>
        {errorReason && <span className={styles.keyError}>{errorReason}</span>}
      </div>
      <div className={styles.controlCol}>{control}</div>
      <div className={styles.metaCol}>
        <span className={styles.defaultLabel}>def: {String(spec.default)}</span>
        {spec.mutability === "warm_reload" && <span className={`${styles.badge} ${styles.badgeWarm}`}>warm</span>}
        {spec.mutability === "restart_required" && <span className={`${styles.badge} ${styles.badgeRestart}`}>restart</span>}
        {spec.mutability === "read_only" && <span className={`${styles.badge} ${styles.badgeReadonly}`}>read-only</span>}
        {spec.requires_privacy_confirm && <span className={`${styles.badge} ${styles.badgePrivacy}`}>privacy</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplatesCard
// ---------------------------------------------------------------------------
function TemplatesCard(props: {
  templates: SettingsTemplate[];
  busy: boolean;
  onApply: (id: string) => Promise<void>;
  onCreate: (name: string, description: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [creating, setCreating] = useState(false);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Templates ({props.templates.length})</h3>
      </div>
      <div className={styles.templateList}>
        {props.templates.map((t) => (
          <div key={t.id} className={styles.templateItem}>
            <div className={styles.templateRow}>
              <div>
                <span className={styles.templateName}>{t.name}</span>
                {t.system && <span className={`${styles.badge} ${styles.badgeReadonly}`} style={{ marginLeft: 6 }}>system</span>}
              </div>
              <span className={styles.subtle}>r{t.latest_revision_no}</span>
            </div>
            {t.description && <span className={styles.templateDesc}>{t.description}</span>}
            <div className={styles.templateActions}>
              <button
                className={styles.btn}
                disabled={props.busy}
                onClick={() => props.onApply(t.id)}
              >
                Apply
              </button>
              {!t.system && (
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={props.busy}
                  onClick={() => {
                    if (confirm(`Delete template "${t.name}"?`)) props.onDelete(t.id);
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <details>
        <summary className={styles.subtle} style={{ cursor: "pointer" }}>+ Save current as template</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <input
            className={styles.tokenInput}
            placeholder="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={styles.tokenInput}
            placeholder="Description (optional)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!name.trim() || creating}
            onClick={async () => {
              setCreating(true);
              try {
                await props.onCreate(name.trim(), desc.trim());
                setName(""); setDesc("");
              } finally {
                setCreating(false);
              }
            }}
          >
            {creating ? "Saving…" : "Save"}
          </button>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BaselineCard
// ---------------------------------------------------------------------------
function BaselineCard({ onCaptured }: { onCaptured: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Baseline</h3>
      </div>
      <p className={styles.subtle} style={{ margin: 0 }}>
        Snapshot the current event buffer. Future changes' impact is computed
        against this baseline.
      </p>
      <button
        className={styles.btn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await adminFetch("/api/settings/baseline/capture", { method: "POST" });
            onCaptured();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Capturing…" : "Capture baseline now"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImpactCard
// ---------------------------------------------------------------------------
function ImpactCard(props: {
  report: ImpactReport | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const r = props.report;
  if (!r) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}><h3 className={styles.cardTitle}>Impact</h3></div>
        <p className={styles.subtle} style={{ margin: 0 }}>
          No active session yet. Apply a change or capture a baseline.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Impact ({r.state})</h3>
        <span className={`${styles.confidenceTier} ${tierClass(r.confidence_tier)}`}>
          {r.confidence_tier}
        </span>
      </div>

      <div className={styles.subtle} style={{ fontSize: 11 }}>
        Audit <code>{r.audit_id.slice(0, 18)}</code>{r.changed_keys.length > 0 && ` • ${r.changed_keys.length} key(s): ${r.changed_keys.slice(0, 2).join(", ")}${r.changed_keys.length > 2 ? "…" : ""}`}
      </div>

      {r.confidence_reasons.length > 0 && (
        <div className={styles.reasonList}>
          {r.confidence_reasons.map((reason) => (
            <span key={reason} className={styles.reasonChip}>{reason}</span>
          ))}
        </div>
      )}

      {r.baseline && r.after_window && (
        <>
          <div className={styles.deltaList}>
            <span>event_rate / min</span>
            <span>{fmt(r.baseline.event_rate_per_min)} → {fmt(r.after_window.event_rate_per_min)}</span>
            <span className={(r.deltas.event_rate_per_min ?? 0) > 0 ? styles.deltaNeg : styles.deltaPos}>
              {fmt(r.deltas.event_rate_per_min, 1)}%
            </span>

            <span>conf p50</span>
            <span>{fmt(r.baseline.confidence_p50)} → {fmt(r.after_window.confidence_p50)}</span>
            <span className={(r.deltas.confidence_p50 ?? 0) > 0 ? styles.deltaPos : styles.deltaNeg}>
              {fmt(r.deltas.confidence_p50, 1)}%
            </span>

            <span>ttc p95</span>
            <span>{fmt(r.baseline.ttc_p95)} → {fmt(r.after_window.ttc_p95)}</span>
            <span className={(r.deltas.ttc_p95 ?? 0) > 0 ? styles.deltaPos : styles.deltaNeg}>
              {fmt(r.deltas.ttc_p95, 1)}%
            </span>

            <span>sample_size</span>
            <span>{r.baseline.sample_size} → {r.after_window.sample_size}</span>
            <span></span>
          </div>

          <SeverityBars label="severity (after)" counts={r.after_window.severity_counts} />
        </>
      )}

      {r.narrative && (
        <div className={styles.narrative}>
          <strong>{(r.recommendation ?? "monitor").toUpperCase()}</strong>: {r.narrative}
        </div>
      )}

      <button className={styles.btn} onClick={props.onRefresh} disabled={props.refreshing}>
        {props.refreshing ? "Refreshing…" : "Refresh"}
      </button>

      <div className={styles.subtle} style={{ fontSize: 10 }}>
        Lagging metrics ({r.lagging_metrics.join(", ")}) need operator feedback.
      </div>
    </div>
  );
}

function SeverityBars({ label, counts }: { label: string; counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
  const order = ["high", "medium", "low", "unknown"];
  const seen = new Set<string>();
  return (
    <div>
      <div className={styles.subtle} style={{ marginBottom: 4 }}>{label}</div>
      <div className={styles.bars}>
        {order
          .filter((k) => counts[k] != null)
          .map((k) => {
            seen.add(k);
            const v = counts[k] ?? 0;
            return (
              <div className={styles.barRow} key={k}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>{k}</div>
                  <div className={styles.bar}>
                    <div className={styles.barFill} style={{ width: `${(v / total) * 100}%` }} />
                  </div>
                </div>
                <span className={styles.subtle}>{v}</span>
              </div>
            );
          })}
        {Object.entries(counts)
          .filter(([k]) => !seen.has(k))
          .map(([k, v]) => (
            <div className={styles.barRow} key={k}>
              <div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>{k}</div>
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

// ---------------------------------------------------------------------------
// SettingsPage
// ---------------------------------------------------------------------------
export function SettingsPage() {
  const { token, setToken, clear } = useAdminToken();
  const settings = useSettings(token);
  const templates = useSettingsTemplates(token);
  const impact = useImpact(token);
  const { data: live, error: liveError } = useLiveStatus(5000);

  const connected: boolean | undefined =
    live ? !!live.running : liveError ? false : undefined;
  const sourceName = live?.source ? shortSource(live.source) : "—";

  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [validationErrors, setValidationErrors] = useState<Array<{ key: string; reason: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [tokenInput, setTokenInput] = useState("");

  // Re-seed the draft from effective values whenever they appear AND the operator
  // hasn't started editing.
  useEffect(() => {
    if (settings.effective && Object.keys(draft).length === 0) {
      setDraft(settings.effective.values as Record<string, DraftValue>);
    }
  }, [settings.effective, draft]);

  const dirtyKeys = useMemo(() => {
    if (!settings.effective) return [];
    return Object.keys(draft).filter((k) => draft[k] !== settings.effective!.values[k]);
  }, [draft, settings.effective]);

  const errorByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of validationErrors) m[e.key] = e.reason;
    return m;
  }, [validationErrors]);

  const groupedSpecs = useMemo(() => {
    if (!settings.schema) return [] as Array<[string, SettingSpec[]]>;
    const by: Record<string, SettingSpec[]> = {};
    for (const s of settings.schema.settings) (by[s.category] ??= []).push(s);
    return Object.entries(by);
  }, [settings.schema]);

  async function doApply(opts: { confirmPrivacy?: boolean } = {}) {
    if (!dirtyKeys.length || !settings.effective) return;
    const diff: Record<string, DraftValue> = {};
    for (const k of dirtyKeys) {
      const v = draft[k];
      if (v !== undefined) diff[k] = v;
    }
    setSubmitting(true);
    setValidationErrors([]);
    setWarnings([]);
    try {
      const res: ApplyResultPayload = await settings.apply(diff, {
        confirm_privacy_change: !!opts.confirmPrivacy,
      });
      setWarnings(res.warnings || []);
      setDraft({});
    } catch (exc) {
      const errors = extractValidationErrors(exc);
      if (errors) { setValidationErrors(errors); return; }
      if (isPrivacyConfirmRequired(exc)) {
        if (confirm("This change touches a privacy-sensitive setting (ALPR_MODE). Confirm?")) {
          await doApply({ confirmPrivacy: true });
          return;
        }
        return;
      }
      if (exc instanceof MissingAdminTokenError) return;
      const status = (exc as AdminApiError).status;
      if (status === 409) {
        alert("Settings changed elsewhere — refreshing the view.");
        await settings.refresh();
        setDraft({});
        return;
      }
      if (status === 429) { alert("Apply rate-limited. Try again in a few seconds."); return; }
      console.error(exc);
      alert(`Apply failed: ${(exc as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function doRollback() {
    if (!confirm("Revert to last-known-good?")) return;
    setSubmitting(true);
    try {
      const res = await settings.rollback();
      setWarnings(res.warnings || []);
      setDraft({});
      await impact.refresh();
    } catch (exc) {
      alert(`Rollback failed: ${(exc as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function doApplyTemplate(id: string) {
    setSubmitting(true);
    try {
      const res = await templates.applyTemplate(id);
      setWarnings(res.warnings || []);
      setDraft({});
      await impact.refresh();
    } catch (exc) {
      if (isPrivacyConfirmRequired(exc)) {
        if (confirm("Template touches a privacy-sensitive setting. Confirm?")) {
          await templates.applyTemplate(id, { confirm_privacy_change: true });
          await settings.refresh();
        }
        return;
      }
      alert(`Apply template failed: ${(exc as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Token-prompt empty state ----
  if (!token || settings.needsToken) {
    return (
      <>
        <TopBar sourceName={sourceName} connected={connected} />
        <main className={styles.main}>
          <section className={styles.center}>
            <div className={styles.tokenWrap}>
              <h2 className={styles.pageTitle}>Settings Console</h2>
              {settings.error && <div className={styles.errorList}>{settings.error}</div>}
              <p className={styles.subtle}>
                Settings is admin-tier. Paste your <code>ROAD_ADMIN_TOKEN</code>{" "}
                (kept in <code>sessionStorage</code>, cleared on tab close).
              </p>
              <div className={styles.tokenPrompt}>
                <input
                  type="password"
                  className={styles.tokenInput}
                  placeholder="ROAD_ADMIN_TOKEN…"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && tokenInput.trim()) setToken(tokenInput.trim());
                  }}
                  autoFocus
                />
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={!tokenInput.trim()}
                  onClick={() => setToken(tokenInput.trim())}
                >
                  Save token for this session
                </button>
              </div>
            </div>
          </section>
        </main>
      </>
    );
  }

  // ---- Main page ----
  return (
    <>
      <TopBar sourceName={sourceName} connected={connected} />
      <main className={styles.main}>
        <section className={styles.center}>
          {/* Page header */}
          <div className={styles.pageHeader}>
            <div className={styles.pageTitleGroup}>
              <h1 className={styles.pageTitle}>Settings</h1>
              <span className={styles.pageSub}>
                schema v{settings.schema?.schema_version ?? 0} • rev #
                {settings.effective?.revision_no ?? 0} •{" "}
                {settings.effective?.revision_hash ?? "—"}
              </span>
            </div>
            <div className={styles.headerActions}>
              <button className={styles.btn} onClick={() => settings.refresh()}>
                Refresh
              </button>
              <button className={`${styles.btn} ${styles.btnGhost}`} onClick={clear}>
                Forget token
              </button>
            </div>
          </div>

          {/* Validation / warnings */}
          {validationErrors.length > 0 && (
            <div className={styles.errorList}>
              {validationErrors.map((e) => (
                <div key={`${e.key}:${e.reason}`}>
                  <strong>{e.key}</strong>: {e.reason}
                </div>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className={styles.warnings}>
              {warnings.map((w) => <div key={w}>{w}</div>)}
            </div>
          )}

          {/* Tunables */}
          {settings.schema && settings.effective && groupedSpecs.map(([cat, specs]) => (
            <details key={cat} className={styles.category} open>
              <summary>{humanize(cat)} <span style={{ float: "right", fontSize: 10 }}>{specs.length}</span></summary>
              <div className={styles.categoryBody}>
                {specs.map((spec) => {
                  const eff = settings.effective!.values[spec.key] as DraftValue;
                  const cur = (draft[spec.key] ?? eff) as DraftValue;
                  return (
                    <TunableControl
                      key={spec.key}
                      spec={spec}
                      effective={eff}
                      draft={cur}
                      errorReason={errorByKey[spec.key] ?? null}
                      onChange={(v) => setDraft({ ...draft, [spec.key]: v })}
                    />
                  );
                })}
              </div>
            </details>
          ))}

          {settings.loading && !settings.schema && (
            <p className={styles.subtle}>Loading settings…</p>
          )}

          {/* Sticky apply bar */}
          <div className={styles.applyBar}>
            <span className={styles.dirtyCount}>
              {dirtyKeys.length} pending change{dirtyKeys.length === 1 ? "" : "s"}
            </span>
            <button
              className={styles.btn}
              disabled={!dirtyKeys.length}
              onClick={() => setDraft({})}
            >
              Discard
            </button>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={submitting}
              onClick={doRollback}
            >
              Rollback to last-good
            </button>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={!dirtyKeys.length || submitting}
              onClick={() => doApply()}
            >
              {submitting ? "Applying…" : `Apply${dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}`}
            </button>
          </div>
        </section>

        <aside className={styles.right}>
          <TemplatesCard
            templates={templates.templates}
            busy={submitting}
            onApply={doApplyTemplate}
            onCreate={async (name, description) => {
              if (!settings.effective) return;
              await templates.create(name, description, settings.effective.values);
            }}
            onDelete={async (id) => templates.remove(id)}
          />
          <BaselineCard onCaptured={() => impact.refresh()} />
          <ImpactCard
            report={impact.report}
            refreshing={impact.refreshing}
            onRefresh={() => impact.refresh()}
          />

          {/* Optional video preview — collapsed by default to save space. */}
          <details className={`${styles.card} ${styles.videoCard}`}>
            <summary className={styles.cardTitle}>Live preview</summary>
            <img src="/admin/video_feed" alt="Live preview" />
            <span className={styles.subtle}>
              source: {sourceName}{live?.target_fps ? ` @ ${live.target_fps}fps` : ""}
            </span>
          </details>
        </aside>
      </main>
    </>
  );
}
