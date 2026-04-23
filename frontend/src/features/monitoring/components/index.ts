/**
 * monitoring/components — barrel for monitoring subcomponents.
 *
 * Exposes IncidentCard, IncidentFeed, SelectionBar, SummaryGrid,
 * SummaryHeader, FilterTile, MetaGrid, and ImmediateActions. Consumed
 * only by `MonitoringPage.tsx` inside the same feature — NOT re-exported
 * from `features/monitoring/index.ts`, so the internals stay private.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: indirect; MonitoringPage imports the re-exported
 *              components from this barrel to compose the page.
 */
export { FilterTile } from "./FilterTile";
export { SummaryHeader } from "./SummaryHeader";
export { SummaryGrid } from "./SummaryGrid";
export { MetaGrid } from "./MetaGrid";
export { SelectionBar } from "./SelectionBar";
export { ImmediateActions } from "./ImmediateActions";
export { IncidentCard } from "./IncidentCard";
export { IncidentFeed } from "./IncidentFeed";
