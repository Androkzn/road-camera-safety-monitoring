/**
 * monitoring — public surface of the monitoring (watchdog-incidents) feature.
 *
 * This barrel is the ONLY thing other features are allowed to import
 * from `features/monitoring`. Everything else (components, hooks, utils)
 * stays private, which keeps the feature boundary honest as the app grows.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: indirect; the app router lazy-loads MonitoringPage via
 *              this barrel to mount the monitoring route.
 */
// Re-export a single named symbol. `export { X } from "..."` is a TS/ES
// module passthrough — no runtime cost, just a named re-export.
export { MonitoringPage } from "./MonitoringPage";
