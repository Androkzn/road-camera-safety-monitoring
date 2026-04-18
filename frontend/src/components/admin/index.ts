/**
 * Barrel file — re-exports every admin subcomponent under a single
 * stable import path.
 *
 * Why this exists:
 *   Without a barrel, pages/AdminPage.tsx would have to write:
 *     import { HealthStrip } from "../components/admin/HealthStrip";
 *     import { VideoFeed }   from "../components/admin/VideoFeed";
 *     import { ... }         from "../components/admin/DetectionsPanel";
 *     ...
 *   With this barrel, the same page writes:
 *     import { HealthStrip, VideoFeed, DetectionsPanel, HistoryPanel, TabBar }
 *       from "../components/admin";
 *   TypeScript + Vite resolve `"../components/admin"` to this file
 *   automatically (the `index.ts` convention).
 *
 * Gotcha:
 *   Barrels can hurt tree-shaking / startup in huge apps because
 *   importing one name still parses all sibling modules. At our size
 *   that doesn't matter; readability wins.
 *
 * TEACH: Only `export { Name }` re-exports (no default exports) so the
 *        imports on the consumer side stay named + grep-friendly.
 */

export { HealthStrip } from "./HealthStrip";
export { VideoFeed } from "./VideoFeed";
export { DetectionsPanel } from "./DetectionsPanel";
export { HistoryPanel } from "./HistoryPanel";
export { TabBar } from "./TabBar";
