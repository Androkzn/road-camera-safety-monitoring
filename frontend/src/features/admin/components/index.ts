/**
 * admin/components — barrel for the admin page's subcomponents.
 *
 * Exposes StreamTile, HealthStrip, DetectionsPanel, HistoryPanel,
 * MultiSourceGrid, and related admin-local components. Imported by
 * `AdminPage.tsx` to compose the live-detections view.
 *
 * --- UI mapping ---
 * Page: AdminPage ([file](frontend/src/features/admin/AdminPage.tsx))
 * UI element: indirect; AdminPage imports the re-exported components
 *              from this barrel to compose the page.
 */
export { HealthStrip } from "./HealthStrip";
export { DetectionsPanel } from "./DetectionsPanel";
export { HistoryPanel } from "./HistoryPanel";
export { MultiSourceGrid } from "./MultiSourceGrid";
export { SelectedStreamHeader } from "./SelectedStreamHeader";
export { StreamImage } from "./StreamImage";
export { AdminEventCard } from "./AdminEventCard";
