/**
 * ui/index.ts — barrel export for primitive UI components.
 *
 * Re-exports the four shared visual primitives (Pill, Dot, Tag, RiskBadge)
 * so callers can `import { Pill, Dot } from "../ui"` instead of reaching into
 * each file. This is purely a convenience — it has no runtime logic.
 */
// Barrel re-exports — lets callers write `import { Pill, Dot, Tag, RiskBadge } from "../ui"` instead of reaching into each file.
export { Pill } from "./Pill";
export { Dot } from "./Dot";
export { Tag } from "./Tag";
export { RiskBadge } from "./RiskBadge";
