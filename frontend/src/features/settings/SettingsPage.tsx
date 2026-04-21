/**
 * SettingsPage — operator-facing tuning console (orchestrator).
 */

import { useMemo } from "react";

import { POLL_INTERVAL_MS } from "../../shared/config/runtime";
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
  const settings = useSettings();
  const templates = useSettingsTemplates();
  const impact = useImpact();
  const { data: live, error: liveError } = useLiveStatus(POLL_INTERVAL_MS.liveStatusSettings);
  const liveSources = useLiveSources(POLL_INTERVAL_MS.liveSourcesSettings);
  const { status: wdStatus } = useWatchdogCtx();
  const driftCount = useDriftCount();
  const dialog = useDialog();

  const connected: boolean | undefined = live ? !!live.running : liveError ? false : undefined;
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

          {validationErrors.length > 0 && <ErrorList errors={validationErrors} />}
          {warnings.length > 0 && <ErrorList errors={warnings} variant="warning" />}
          <ApplyResultBanner result={applyResult} onDismiss={dismissApplyResult} />

          {settings.error && !settings.schema && (
            <>
              <ErrorList errors={[`Failed to load settings. ${settings.error}`]} />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => void settings.refresh()}
                  disabled={settings.loading}
                >
                  {settings.loading ? "Retrying…" : "Retry"}
                </button>
              </div>
            </>
          )}

          {settings.schema && settings.effective && (
            <TunablesColumn
              groupedSpecs={groupedSpecs}
              effective={settings.effective}
              draft={draft}
              errorByKey={errorByKey}
              onChange={(key, value) => setDraft((prev) => ({ ...prev, [key]: value }))}
            />
          )}

          {!settings.schema && !settings.error && (
            <p className={styles.subtle}>
              {settings.loading ? "Loading settings…" : "Settings not loaded yet."}
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
              await templates.create(name, description, settings.effective.values);
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
