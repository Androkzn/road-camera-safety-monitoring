/**
 * Barrel file for the dashboard components folder.
 *
 * TEACH: A "barrel" is an index.ts that re-exports symbols from sibling files.
 * It lets consumers write:
 *     import { SummaryTiles, CopilotPanel } from "../components/dashboard";
 * instead of three separate imports pointing at each file. The bundler (Vite)
 * tree-shakes unused re-exports, so this is free at runtime.
 *
 * Rendered by: pages/DashboardPage.tsx — see how it pulls these three
 * components + one row-component group to compose the whole dashboard.
 */

// TEACH: `export { X } from "./path"` re-exports without importing into
// local scope. Compare to `import { X } from ...; export { X };` which
// would do the same thing but is more verbose.
export { SummaryTiles } from "./SummaryTiles";
export { PerceptionBannerRow, SceneBannerRow, DriftBannerRow } from "./PerceptionBanner";
export { CopilotPanel } from "./CopilotPanel";
