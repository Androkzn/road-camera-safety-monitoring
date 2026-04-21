/**
 * dashboard/index.ts — barrel export for Dashboard-page components.
 *
 * Re-exports `SummaryTiles`, the three banner rows (Perception, Scene,
 * Drift), and `CopilotPanel` so `DashboardPage.tsx` can import them all
 * from `../components/dashboard`. Purely organizational.
 */
export { SummaryTiles } from "./SummaryTiles";
export { PerceptionBannerRow, SceneBannerRow, DriftBannerRow } from "./PerceptionBanner";
export { CopilotPanel } from "./CopilotPanel";
