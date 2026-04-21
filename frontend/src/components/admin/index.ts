/**
 * admin/index.ts — barrel export for Admin-page components.
 *
 * Re-exports HealthStrip, VideoFeed, DetectionsPanel, HistoryPanel, and
 * TabBar so `AdminPage.tsx` can import them all from one path. Purely
 * organizational; no runtime behavior.
 */
// Barrel file: re-exports every Admin-page component so AdminPage.tsx can
// import them from one path (`../components/admin`). No runtime behavior.
export { HealthStrip } from "./HealthStrip";
export { VideoFeed } from "./VideoFeed";
export { DetectionsPanel } from "./DetectionsPanel";
export { HistoryPanel } from "./HistoryPanel";
export { TabBar } from "./TabBar";
