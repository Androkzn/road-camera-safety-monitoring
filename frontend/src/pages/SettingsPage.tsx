/**
 * SettingsPage — operator-facing tuning console.
 *
 * Three columns on desktop:
 *   left   — live MJPEG stream (reuses VideoFeed) + admin token controls.
 *   center — grouped tunables with apply/rollback bar at the bottom.
 *   right  — templates list + baseline/impact panel + AI advisory.
 *
 * The intentional simplicity here is to keep the v1 self-contained: no
 * recharts dep, no fancy state machine, no SSE wiring. Pollers + small
 * hooks are enough to exercise the entire backend surface end-to-end.
 */

import { useEffect, useMemo, useState } from "react";

import { TopBar } from "../components/layout/TopBar";
import { VideoFeed } from "../components/admin/VideoFeed";
import { useAdminToken } from "../hooks/useAdminToken";
import { useImpact } from "../hooks/useImpact";
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

function describeTier(tier: ConfidenceTier): string {
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
  const cls = `${styles.tunable} ${dirty ? styles.dirty : ""} ${errorReason ? styles.error : ""}`;

  let control: React.ReactNode;
  if (spec.type === "enum" && spec.enum) {
    control = (
      <select value={String(draft)} onChange={(e) => onChange(e.target.value)}>
        {spec.enum.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  } else if (spec.type === "bool") {
    control = (
      <input
        type="checkbox"
        checked={!!draft}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  } else if (spec.type === "int" || spec.type === "float") {
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const step = spec.type === "int" ? 1 : Math.max((max - min) / 200, 0.01);
    control = (
      <>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) =>
            onChange(spec.type === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value))
          }
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) =>
            onChange(spec.type === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value))
          }
        />
      </>
    );
  } else {
    control = (
      <input type="text" value={String(draft)} onChange={(e) => onChange(e.target.value)} />
    );
  }

  return (
    <div className={cls}>
      <div>
        <span className={styles.keyName}>{spec.key}</span>
        <span className={styles.keyDesc}>{spec.description}</span>
        {errorReason && <span className={styles.keyDesc} style={{ color: "#fca5a5" }}>{errorReason}</span>}
      </div>
      <div className={styles.controlCol}>{control}</div>
      <div className={styles.metaCol}>
        <span>default: {String(spec.default)}</span>
        {spec.mutability === "warm_reload" && <span className={`${styles.badge} ${styles.badgeWarm}`}>warm reload</span>}
        {spec.mutability === "restart_required" && <span className={`${styles.badge} ${styles.badgeRestart}`}>restart</span>}
        {spec.requires_privacy_confirm && <span className={`${styles.badge} ${styles.badgeWarm}`}>privacy</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplateManager
// ---------------------------------------------------------------------------
function TemplateManager(props: {
  templates: SettingsTemplate[];
  loading: boolean;
  onApply: (id: string) => Promise<void>;
  onCreate: (name: string, description: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <div className={styles.headerRow}>
        <h3 className={styles.title}>Templates</h3>
        <span className={styles.subtle}>{props.templates.length} total</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {props.templates.map((t) => (
          <div key={t.id} className={styles.templateCard}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h4>
                {t.name}{" "}
                {t.system && (
                  <span className={`${styles.badge} ${styles.badgeReadonly}`}>system</span>
                )}
              </h4>
              <span className={styles.subtle}>r{t.latest_revision_no}</span>
            </div>
            {t.description && <p>{t.description}</p>}
            <div className={styles.templateActions}>
              <button
                className={styles.btn}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try { await props.onApply(t.id); } finally { setBusy(false); }
                }}
              >
                Apply
              </button>
              {!t.system && (
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm(`Delete template "${t.name}"?`)) return;
                    setBusy(true);
                    try { await props.onDelete(t.id); } finally { setBusy(false); }
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        <input
          className={styles.tokenInput}
          placeholder="New template name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={styles.tokenInput}
          placeholder="Description"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={!name.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await props.onCreate(name.trim(), desc.trim());
              setName("");
              setDesc("");
            } finally {
              setBusy(false);
            }
          }}
        >
          Save current as template
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImpactPanel
// ---------------------------------------------------------------------------
function ImpactPanel(props: {
  report: ImpactReport | null;
  refreshing: boolean;
  onRefresh: () => void;
  onRequestNarrative: () => void;
  narrativeBusy: boolean;
}) {
  const r = props.report;
  if (!r) {
    return (
      <div className={styles.impactCard}>
        <h3 className={styles.title}>Impact</h3>
        <p className={styles.subtle}>
          No active session. Apply a change or capture a baseline to start
          monitoring.
        </p>
      </div>
    );
  }
  return (
    <div className={styles.impactCard}>
      <div className={styles.headerRow}>
        <h3 className={styles.title}>Impact ({r.state})</h3>
        <span className={`${styles.confidenceTier} ${describeTier(r.confidence_tier)}`}>
          {r.confidence_tier}
        </span>
      </div>
      <p className={styles.subtle}>
        Audit {r.audit_id} • {r.changed_keys.length} key(s):{" "}
        {r.changed_keys.slice(0, 3).join(", ") || "—"}
        {r.changed_keys.length > 3 && "…"}
      </p>
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
          {/* Lightweight inline bar comparison for severity counts. */}
          <SeverityBars
            label="severity (baseline)"
            counts={r.baseline.severity_counts}
          />
          <SeverityBars
            label="severity (after)"
            counts={r.after_window.severity_counts}
          />
        </>
      )}
      {r.narrative && (
        <div className={styles.narrative}>
          <strong>{(r.recommendation ?? "monitor").toUpperCase()}</strong>: {r.narrative}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className={styles.btn} onClick={props.onRefresh} disabled={props.refreshing}>
          {props.refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button className={styles.btn} onClick={props.onRequestNarrative} disabled={props.narrativeBusy}>
          {props.narrativeBusy ? "Asking AI…" : "Generate AI summary"}
        </button>
      </div>
      <div className={styles.subtle} style={{ marginTop: 4, fontSize: 11 }}>
        Lagging metrics ({r.lagging_metrics.join(", ")}) require operator
        feedback before they can be compared. Awaiting verdicts.
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
      <div className={styles.subtle} style={{ marginTop: 4 }}>{label}</div>
      <div className={styles.bars}>
        {order
          .filter((k) => counts[k] != null)
          .map((k) => {
            seen.add(k);
            return (
              <div className={styles.barRow} key={k}>
                <div>
                  <div>{k}</div>
                  <div className={styles.bar}>
                    <div
                      className={styles.barFill}
                      style={{ width: `${((counts[k] ?? 0) / total) * 100}%` }}
                    />
                  </div>
                </div>
                <span className={styles.subtle}>{counts[k] ?? 0}</span>
              </div>
            );
          })}
        {Object.entries(counts)
          .filter(([k]) => !seen.has(k))
          .map(([k, v]) => (
            <div className={styles.barRow} key={k}>
              <div>
                <div>{k}</div>
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

  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [validationErrors, setValidationErrors] = useState<Array<{ key: string; reason: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [narrativeBusy, setNarrativeBusy] = useState(false);

  // Re-seed the draft whenever the effective values change AND the operator
  // hasn't started editing.
  useEffect(() => {
    if (settings.effective && Object.keys(draft).length === 0) {
      setDraft(settings.effective.values as Record<string, DraftValue>);
    }
  }, [settings.effective, draft]);

  const dirtyKeys = useMemo(() => {
    if (!settings.effective) return [];
    const out: string[] = [];
    for (const k of Object.keys(draft)) {
      if (draft[k] !== settings.effective.values[k]) out.push(k);
    }
    return out;
  }, [draft, settings.effective]);

  const errorByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of validationErrors) m[e.key] = e.reason;
    return m;
  }, [validationErrors]);

  const groupedSpecs = useMemo(() => {
    if (!settings.schema) return [] as Array<[string, SettingSpec[]]>;
    const by: Record<string, SettingSpec[]> = {};
    for (const s of settings.schema.settings) {
      (by[s.category] ??= []).push(s);
    }
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
      if (errors) {
        setValidationErrors(errors);
        return;
      }
      if (isPrivacyConfirmRequired(exc)) {
        if (confirm("This change touches a privacy-sensitive setting (ALPR_MODE). Confirm?")) {
          await doApply({ confirmPrivacy: true });
          return;
        }
        return;
      }
      if (exc instanceof MissingAdminTokenError) {
        // bubble up to the empty state
        return;
      }
      const status = (exc as AdminApiError).status;
      if (status === 409) {
        alert("Settings changed elsewhere — refreshing the view.");
        await settings.refresh();
        setDraft({});
        return;
      }
      if (status === 429) {
        alert("Apply rate-limited. Try again in a few seconds.");
        return;
      }
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

  async function requestNarrative() {
    if (!impact.report) return;
    setNarrativeBusy(true);
    try {
      // The backend doesn't yet expose a public narrative endpoint by default;
      // we trigger it by re-applying a no-op so the next impact tick refreshes.
      // (For v1.5 we'll add a dedicated POST /api/settings/impact/narrate.)
      await impact.refresh();
    } finally {
      setNarrativeBusy(false);
    }
  }

  // Token-prompt empty state
  if (!token) {
    return (
      <>
        <TopBar />
        <main className={styles.main}>
          <div className={styles.left}>
            <h2 className={styles.title}>Settings Console</h2>
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
          <div className={styles.center} />
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <main className={styles.main}>
        <aside className={styles.left}>
          <h2 className={styles.title}>Live</h2>
          <VideoFeed stats={{ detections: 0, persons: 0, vehicles: 0, interactions: 0, fps: "—" }} />
          <div className={styles.subtle}>
            Effective revision: {settings.effective?.revision_hash ?? "—"} (#
            {settings.effective?.revision_no ?? 0})
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className={styles.btn} onClick={() => settings.refresh()}>
              Refresh
            </button>
            <button className={styles.btn} onClick={clear}>
              Forget token
            </button>
          </div>
        </aside>

        <section className={styles.center}>
          <div className={styles.headerRow}>
            <h2 className={styles.title}>
              Settings ({settings.schema?.settings.length ?? 0} tunables)
            </h2>
            <span className={styles.subtle}>
              schema v{settings.schema?.schema_version ?? 0}
            </span>
          </div>

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

          {settings.schema && settings.effective && groupedSpecs.map(([cat, specs]) => (
            <details key={cat} className={styles.category} open>
              <summary>{cat}</summary>
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
            </details>
          ))}

          <div className={styles.applyBar}>
            <span className={styles.dirtyCount}>
              {dirtyKeys.length} pending change{dirtyKeys.length === 1 ? "" : "s"}
            </span>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={!dirtyKeys.length || submitting}
              onClick={() => doApply()}
            >
              {submitting ? "Applying…" : "Apply"}
            </button>
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
          </div>
        </section>

        <aside className={styles.right}>
          <TemplateManager
            templates={templates.templates}
            loading={templates.loading}
            onApply={doApplyTemplate}
            onCreate={async (name, description) => {
              if (!settings.effective) return;
              await templates.create(name, description, settings.effective.values);
            }}
            onDelete={async (id) => templates.remove(id)}
          />
          <BaselineCapture token={token} onCaptured={() => impact.refresh()} />
          <ImpactPanel
            report={impact.report}
            refreshing={impact.refreshing}
            onRefresh={() => impact.refresh()}
            onRequestNarrative={requestNarrative}
            narrativeBusy={narrativeBusy}
          />
        </aside>
      </main>
    </>
  );
}

function BaselineCapture({ token, onCaptured }: { token: string; onCaptured: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.impactCard}>
      <div className={styles.headerRow}>
        <h3 className={styles.title}>Baseline</h3>
      </div>
      <p className={styles.subtle}>
        Capture a baseline window from the current event buffer; impact deltas
        will be computed against it.
      </p>
      <button
        className={styles.btn}
        disabled={busy}
        onClick={async () => {
          if (!token) return;
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
