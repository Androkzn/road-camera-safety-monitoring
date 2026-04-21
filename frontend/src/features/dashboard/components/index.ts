/**
 * dashboard/components — barrel for dashboard subcomponents.
 *
 * Exposes CopilotPanel, PerceptionBanner (PerceptionBannerRow /
 * SceneBannerRow / DriftBannerRow), and SummaryTiles. Imported by
 * `DashboardPage.tsx` to compose the fleet-overview view.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: indirect; DashboardPage imports the re-exported
 *              components from this barrel to compose the page.
 */
export { SummaryTiles } from "./SummaryTiles";
export { CopilotPanel } from "./CopilotPanel";
export { PerceptionBannerRow, SceneBannerRow, DriftBannerRow } from "./PerceptionBanner";
