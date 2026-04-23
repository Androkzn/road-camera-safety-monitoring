/**
 * Monitoring-feature types — derived from upstream WatchdogFinding.
 *
 * These types exist because the backend ships RAW findings (one row
 * per error occurrence) but the UI wants INCIDENTS (one card per
 * fingerprint, with a count). `utils/incidents.ts` does that collapse.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: No direct UI — defines the SevFilter union used by the
 *   four filter tiles and the WatchdogIncident shape rendered as each
 *   card in the incident feed.
 */
// `import type { … }` is TS-only syntax: it imports a type for type-checking
// and is erased from the runtime bundle. Use it whenever you're only using
// the symbol in a type position — zero runtime cost.
import type { WatchdogFinding } from "../../shared/types/common";

/**
 * Union type = "one of these literal strings, nothing else". TypeScript
 * will narrow this in `if (filter === "error")` blocks so typos become
 * compile-time errors.
 */
export type SevFilter = "all" | "error" | "warning" | "info";

/**
 * A collapsed incident group. Many `WatchdogFinding`s that share the same
 * fingerprint become ONE `WatchdogIncident`. `count`/`rawKeys` track the
 * roll-up; `latest` keeps the most recent raw finding for display.
 *
 * `?:` marks an optional property — it may be undefined.
 * `interface` vs `type`: either works here. Interfaces are preferred
 * for object shapes because they can be extended and give cleaner errors.
 */
export interface WatchdogIncident {
  id: string;
  fingerprint: string;
  severity: "error" | "warning" | "info";
  category: string;
  title: string;
  owner?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  rawKeys: string[];
  latest: WatchdogFinding;
}
