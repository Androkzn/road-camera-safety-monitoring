/**
 * settings/components — barrel for Settings Console subcomponents.
 *
 * Exposes Tunable, ImpactCard, OpsDeltas, SeverityBars, SettingsHeader,
 * ApplyResultBanner, TunablesColumn, and LivePreviewCard. Imported by
 * `SettingsPage.tsx` to compose the operator tuning console.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: indirect; SettingsPage imports the re-exported
 *              components from this barrel to compose the page.
 */
// Barrel-only re-exports. No network calls; each component owns its own
// BE interactions (most are presentational and receive data via props from
// SettingsPage / its hooks).

/** Tunable — one slider/number/bool/enum row for a single SettingSpec. */
export { Tunable } from "./Tunable";
/** ImpactCard — right-column dry-run preview driven by useImpact()
 *  (GET /api/settings/impact). Hosts SeverityBars + OpsDeltas. */
export { ImpactCard } from "./ImpactCard";
/** OpsDeltas — renders the ops-metric deltas block inside ImpactCard. */
export { OpsDeltas } from "./OpsDeltas";
/** SeverityBars — stacked-bar viz of before/after severity counts. */
export { SeverityBars } from "./SeverityBars";
/** SettingsHeader — "N tunables changed" pill + Discard / Apply buttons. */
export { SettingsHeader } from "./SettingsHeader";
/** ApplyResultBanner — surfaces the POST /api/settings/apply response
 *  (applied_now / pending_restart / warnings / audit_id). */
export { ApplyResultBanner } from "./ApplyResultBanner";
export type { ApplyResultPayloadView } from "./ApplyResultBanner";
/** TunablesColumn — renders one section per category with a Tunable row
 *  for each SettingSpec. */
export { TunablesColumn } from "./TunablesColumn";
/** LivePreviewCard — MJPEG/poll thumbnail of the primary source so the
 *  operator can visually correlate slider changes with what fires. */
export { LivePreviewCard } from "./LivePreviewCard";
