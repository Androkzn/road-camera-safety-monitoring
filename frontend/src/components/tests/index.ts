/**
 * Barrel file for the tests-UI components folder.
 *
 * TEACH: Same pattern as dashboard/index.ts — one import path for
 * consumers. Used by App.tsx (which mounts TestBadge in the TopBar and
 * TestDrawer as a slide-in panel) and by pages that want to surface the
 * pytest results.
 */

// TEACH: Named re-exports. The component's runtime identity is unchanged;
// this just widens its visibility.
export { TestBadge } from "./TestBadge";
export { TestDrawer } from "./TestDrawer";
