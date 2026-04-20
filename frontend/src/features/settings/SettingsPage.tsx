/**
 * SettingsPage — operator-facing tuning console (orchestrator).
 *
 * Was a 1,564-line god component. Then a 431-line thin page. Now a
 * ~210-line page after D1.A extracted the apply/rollback/template
 * lifecycle into `useSettingsApply` and the no-token empty state into
 * `<TokenEmptyState>`.
 *
 * Layout (responsive):
 *   [TopBar]
 *   ┌─────────────────────────────┬──────────────────┐
 *   │ Page header + apply bar     │ Templates        │
 *   │ Validation / warnings       │ Baseline         │
 *   │ <details> per category      │ Impact           │
 *   │   tunable rows…             │ (Live preview)   │
 *   └─────────────────────────────┴──────────────────┘
 */

import { useMemo } from "react";

import { POLL_INTERVAL_MS } from "../../shared/config/runtime";
import { useAdminToken } from "../../shared/hooks/useAdminToken";
import { useLiveStatus } from "../../shared/hooks/useLiveStatus";
import { TopBar } from "../../shared/layout/TopBar";
import { ErrorList, useDialog } from "../../shared/ui";
import { useLiveSources } from "../admin/hooks/useLiveSources";
import { useDriftCount } from "../validation";
import { useWatchdogCtx } from "../watchdog";

import {
  ApplyResultBanner,
  BaselineCard,
  ImpactCard,
  LivePreviewCard,
  SettingsHeader,
  TemplatesCard,
  TokenEmptyState,
  TunablesColumn,
} from "./components";
import { useImpact } from "./hooks/useImpact";
import { useSettings } from "./hooks/useSettings";
import { useSettingsApply } from "./hooks/useSettingsApply";
import { useSettingsTemplates } from "./hooks/useSettingsTemplates";
import { shortSource } from "./utils/formatting";
import type { SettingSpec } from "./types";

import styles from "./SettingsPage.module.css";

export function SettingsPage() {
  const { token, setToken, clear: clearToken } = useAdminToken();
  const settings = useSettings(token);
  const templates = useSettingsTemplates(token);
  const impact = useImpact(token);
  // D2.A: Settings only uses live/liveSources to feed the TopBar uptime
  // pill — not a second-by-second indicator. Drop the poll frequency from
  // 5 s to 15 s on this page. Other pages that mount these hooks keep
  // their defaults.
  const { data: live, error: liveError } = useLiveStatus(
    POLL_INTERVAL_MS.liveStatusSettings,
  );
  const liveSources = useLiveSources(POLL_INTERVAL_MS.liveSourcesSettings);
  const { status: wdStatus } = useWatchdogCtx();
  const driftCount = useDriftCount();
  const dialog = useDialog();

  const connected: boolean | undefined = live
    ? !!live.running
    : liveError
      ? false
      : undefined;
  const sourceName = live?.source ? shortSource(live.source) : "—";
  const errorCount = wdStatus?.by_severity?.error ?? 0;

  const {
    draft,
    setDraft,
    dirtyKeys,
    validationErrors,
    warnings,
    applyResult,
    submitting,
    apply,
    rollback,
    applyTemplate,
    discardDraft,
    dismissApplyResult,
  } = useSettingsApply({ settings, templates, impact, dialog });

  const errorByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of validationErrors) m[e.key] = e.reason;
    return m;
  }, [validationErrors]);

  const groupedSpecs = useMemo<Array<[string, SettingSpec[]]>>(() => {
    if (!settings.schema) return [];
    const by: Record<string, SettingSpec[]> = {};
    for (const s of settings.schema.settings) (by[s.category] ??= []).push(s);
    return Object.entries(by);
  }, [settings.schema]);

  // -------------------------------------------------------------------------
  // Token-prompt empty state
  // -------------------------------------------------------------------------
  if (!token || settings.needsToken) {
    return (
      <TokenEmptyState
        sourceName={sourceName}
        connected={connected}
        errorCount={errorCount}
        driftCount={driftCount}
        error={settings.error}
        onSave={setToken}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Main page
  // -------------------------------------------------------------------------
  return (
    <>
      <TopBar
        sourceName={sourceName}
        connected={connected}
        errorCount={errorCount}
        driftCount={driftCount}
      />
      <main className={styles.main}>
        <section className={styles.center}>
          <SettingsHeader
            dirtyCount={dirtyKeys.length}
            submitting={submitting}
            onDiscard={discardDraft}
            onRollback={rollback}
            onApply={apply}
          />

          {validationErrors.length > 0 && (
            <ErrorList errors={validationErrors} />
          )}
          {warnings.length > 0 && (
            <ErrorList errors={warnings} variant="warning" />
          )}
          <ApplyResultBanner
            result={applyResult}
            onDismiss={dismissApplyResult}
          />

          {settings.error && !settings.schema && (
            <div className={styles.errorList}>
              <div>
                <strong>Failed to load settings.</strong> {settings.error}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => void settings.refresh()}
                  disabled={settings.loading}
                >
                  {settings.loading ? "Retrying…" : "Retry"}
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => clearToken()}
                  title="Clear the cached admin token and re-prompt"
                >
                  Forget token
                </button>
              </div>
            </div>
          )}

          {settings.schema && settings.effective && (
            <TunablesColumn
              groupedSpecs={groupedSpecs}
              effective={settings.effective}
              draft={draft}
              errorByKey={errorByKey}
              onChange={(key, value) =>
                setDraft((prev) => ({ ...prev, [key]: value }))
              }
            />
          )}

          {!settings.schema && !settings.error && (
            <p className={styles.subtle}>
              {settings.loading
                ? "Loading settings…"
                : "Settings not loaded yet."}
            </p>
          )}
        </section>

        <aside className={styles.right}>
          <TemplatesCard
            templates={templates.templates}
            busy={submitting}
            onApply={applyTemplate}
            onCreate={async (name, description) => {
              if (!settings.effective) return;
              await templates.create(
                name,
                description,
                settings.effective.values,
              );
            }}
            onDelete={async (id) => templates.remove(id)}
          />
          <BaselineCard onCaptured={() => impact.refresh()} />
          <ImpactCard
            report={impact.report}
            refreshing={impact.refreshing}
            lastUpdatedTs={impact.lastUpdatedTs}
            onRefresh={() => impact.refresh()}
          />
          <LivePreviewCard
            sources={liveSources.sources}
            primaryId={liveSources.primaryId}
            fallbackSourceName={sourceName}
            targetFps={live?.target_fps}
          />
        </aside>
      </main>
    </>
  );
}
