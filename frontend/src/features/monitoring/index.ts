/**
 * monitoring feature — public surface.
 *
 * This barrel file is the ONLY thing other features are allowed to import
 * from `features/monitoring`. Everything else (components, hooks, utils)
 * stays private. Keeps the feature boundary honest as the app grows.
 */
// Re-export a single named symbol. `export { X } from "..."` is a TS/ES
// module passthrough — no runtime cost, just a named re-export.
export { MonitoringPage } from "./MonitoringPage";
