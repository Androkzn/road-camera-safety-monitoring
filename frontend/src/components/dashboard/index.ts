/**
 * dashboard/index.ts — barrel export for Dashboard-page components.
 *
 * Re-exports `SummaryTiles`, the three banner rows (Perception, Scene,
 * Drift), and `CopilotPanel` so `DashboardPage.tsx` can import them all
 * from `../components/dashboard`. Purely organizational.
 */
// Barrel file: re-exports every Dashboard-page component so DashboardPage.tsx
// can import them all from one path (`../components/dashboard`).
export { SummaryTiles } from "./SummaryTiles";
export { PerceptionBannerRow, SceneBannerRow, DriftBannerRow } from "./PerceptionBanner";
export { CopilotPanel } from "./CopilotPanel";
