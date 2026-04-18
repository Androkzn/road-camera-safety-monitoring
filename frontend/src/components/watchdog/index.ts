/**
 * watchdog/ — barrel file.
 *
 * TEACH: Barrel files collect a folder's public components into one import
 *        path. Other files can do:
 *            import { WatchdogBadge, WatchdogDrawer } from "../components/watchdog";
 *
 * What lives in this folder:
 *   - WatchdogBadge  — small pill rendered in the TopBar (alert count).
 *   - WatchdogDrawer — side panel listing system-health findings.
 *
 * Both components get their data from `hooks/WatchdogContext.tsx` via
 * `useWatchdogCtx()` higher up the tree, and are typically opened/closed
 * from parent pages (AdminPage, MonitoringPage).
 */

export { WatchdogBadge } from "./WatchdogBadge";
export { WatchdogDrawer } from "./WatchdogDrawer";
