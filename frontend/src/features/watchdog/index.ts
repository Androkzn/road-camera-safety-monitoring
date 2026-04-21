/**
 * watchdog feature — public surface (barrel file).
 *
 * The watchdog is the incident queue: the backend groups repeated
 * errors into fingerprinted findings, and this feature renders them
 * in a drawer plus surfaces a severity badge in the TopBar.
 *
 * Other features should import only from this barrel.
 */

export { WatchdogProvider, useWatchdogCtx } from "./WatchdogContext";
export { WatchdogBadge } from "./components/WatchdogBadge";
export { WatchdogDrawer } from "./components/WatchdogDrawer";
export { watchdogApi, watchdogQueryKeys } from "./api";
