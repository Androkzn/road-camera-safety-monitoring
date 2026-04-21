/**
 * watchdog/index.ts — barrel export for watchdog UI components.
 *
 * Re-exports `WatchdogBadge` (compact top-bar chip) and `WatchdogDrawer`
 * (slide-out panel with findings). Purely organizational.
 */
// Barrel re-exports — lets callers import the top-bar chip and its paired slide-out drawer in one line.
export { WatchdogBadge } from "./WatchdogBadge";
export { WatchdogDrawer } from "./WatchdogDrawer";
