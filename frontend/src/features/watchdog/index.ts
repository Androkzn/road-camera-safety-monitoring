/**
 * watchdog — public surface of the watchdog feature.
 *
 * Exposes `WatchdogProvider` / `useWatchdogCtx` (context),
 * `WatchdogBadge` (TopBar severity indicator), and `WatchdogDrawer`
 * (incident queue UI). The backend groups repeated errors into
 * fingerprinted findings; this feature renders them. Other features
 * must import only from this barrel.
 *
 * --- UI mapping ---
 * Page: ALL pages (WatchdogProvider wraps the app; badge lives in TopBar).
 * UI element: WatchdogBadge in TopBar; WatchdogDrawer opens on click.
 */

export { WatchdogProvider, useWatchdogCtx } from "./WatchdogContext";
export { WatchdogBadge } from "./components/WatchdogBadge";
export { WatchdogDrawer } from "./components/WatchdogDrawer";
export { watchdogApi, watchdogQueryKeys } from "./api";
