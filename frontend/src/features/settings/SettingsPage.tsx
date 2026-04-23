/**
 * The Settings page itself — the screen operators use to tune the system.
 *
 * This is the whole page layout: a top bar, a left column of tunable sliders
 * grouped by category, and a right column with the impact card and a small
 * live-video preview. It glues together every other file in this folder.
 *
 * Page: SettingsPage
 *   ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: the entire Settings page (everything between the top bar and the
 *   bottom of the screen).
 * Backend: GET /api/settings/schema, GET /api/settings/effective,
 *   POST /api/settings/apply, GET /api/settings/impact, GET /api/live/status.
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
  ImpactCard,
  LivePreviewCard,
  SettingsHeader,
  TunablesColumn,
} from "./components";
import { useImpact } from "./hooks/useImpact";
import { useSettings } from "./hooks/useSettings";
import { useSettingsApply } from "./hooks/useSettingsApply";
import { shortSource } from "./utils/formatting";
import type { SettingSpec } from "./types";

import styles from "./SettingsPage.module.css";

/**
 * SettingsPage — operator tuning console.
 *
 * UI: full page. TopBar (status strip) + center TunablesColumn (sliders per
 *   tunable, grouped by category, each with a Tunable row, live value badge,
 *   validation error, and help popover) + right-hand ImpactCard (predicted
 *   impact preview with severity bars and ops deltas) + LivePreviewCard
 *   (small MJPEG/poll thumbnail of the primary source). Also renders
 *   validation ErrorList, warning ErrorList, ApplyResultBanner, and a
 *   discard/apply header.
 * BE calls (via hooks/api.ts wrappers):
 *   - GET /api/settings/schema and /api/settings/effective (useSettings) to
 *     seed the sliders and their bounds/steps.
 *   - POST /api/settings/validate + POST /api/settings/apply
 *     (useSettingsApply) to stage and commit a diff.
 *   - GET /api/settings/impact (useImpact) for the right-column dry-run.
 *   - GET /api/live/status (useLiveStatus) for TopBar connection state.
 */
export function SettingsPage() {
  // Schema + current effective values + refresh helpers.
  const settings = useSettings();
  // Polls /api/settings/impact for the right-column ImpactCard.
  const impact = useImpact();
  // TopBar connectivity and source label — pulled on a settings-tuned poll interval.
  const { data: live, error: liveError } = useLiveStatus(POLL_INTERVAL_MS.liveStatusSettings);
  // List of perception sources for the LivePreviewCard thumbnail.
  const liveSources = useLiveSources(POLL_INTERVAL_MS.liveSourcesSettings);
  // Watchdog error count feeds the TopBar badge.
  const { status: wdStatus } = useWatchdogCtx();
  // Open-drift count — also rendered in the TopBar.
  const driftCount = useDriftCount();
  // Confirm dialog for privacy-sensitive applies (see useSettingsApply).
  const dialog = useDialog();

  // Tri-state for TopBar: true=running, false=API errored, undefined=unknown/loading.
  const connected: boolean | undefined = live ? !!live.running : liveError ? false : undefined;
  // Truncate long URLs/paths to a short display token for the TopBar.
  const sourceName = live?.source ? shortSource(live.source) : "—";
  // Watchdog severity histogram → TopBar error badge count.
  const errorCount = wdStatus?.by_severity?.error ?? 0;

  // Draft state + apply pipeline. Owns the diff from effective values and
  // the POST /api/settings/validate + /api/settings/apply lifecycle.
  const {
    draft,
    setDraft,
    dirtyKeys,
    validationErrors,
    warnings,
    applyResult,
    submitting,
    apply,
    discardDraft,
    dismissApplyResult,
  } = useSettingsApply({ settings, impact, dialog });

  // Flatten the validation-error list into a by-key lookup so each Tunable
  // row can render its own error without scanning the whole array every frame.
  const errorByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of validationErrors) m[e.key] = e.reason;
    return m;
  }, [validationErrors]);

  // Group the flat schema.settings[] into [category, specs[]] pairs so
  // TunablesColumn can render one section per category. `??=` seeds the
  // bucket lazily; Object.entries preserves first-seen order.
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
          {/* Header strip: dirty-count pill + Discard / Apply buttons. */}
          <SettingsHeader
            dirtyCount={dirtyKeys.length}
            submitting={submitting}
            onDiscard={discardDraft}
            onApply={apply}
          />

          {/* Client- and server-side validation errors (reject the apply). */}
          {validationErrors.length > 0 && <ErrorList errors={validationErrors} />}
          {/* Non-blocking warnings (e.g. warm-reload hint). */}
          {warnings.length > 0 && <ErrorList errors={warnings} variant="warning" />}
          {/* Post-apply success/failure banner surfaced by useSettingsApply. */}
          <ApplyResultBanner result={applyResult} onDismiss={dismissApplyResult} />

          {/* Hard failure loading /api/settings/schema or /effective: show
              error and a manual retry instead of the sliders. */}
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

          {/* Happy path: render one slider per tunable, grouped by category.
              onChange stages the value into `draft`; apply() is what actually
              POSTs to /api/settings/apply. */}
          {settings.schema && settings.effective && (
            <TunablesColumn
              groupedSpecs={groupedSpecs}
              effective={settings.effective}
              draft={draft}
              errorByKey={errorByKey}
              onChange={(key, value) => setDraft((prev) => ({ ...prev, [key]: value }))}
            />
          )}

          {/* Initial load state (no schema, no error yet). */}
          {!settings.schema && !settings.error && (
            <p className={styles.subtle}>
              {settings.loading ? "Loading settings…" : "Settings not loaded yet."}
            </p>
          )}
        </section>

        <aside className={styles.right}>
          {/* Predicted-impact dry-run for the pending diff:
              /api/settings/impact → severity bars + ops deltas. */}
          <ImpactCard
            report={impact.report}
            refreshing={impact.refreshing}
            lastUpdatedTs={impact.lastUpdatedTs}
            onRefresh={() => impact.refresh()}
          />
          {/* Small live thumbnail of the primary source so operators can see
              whether a threshold change actually changes what fires. */}
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
