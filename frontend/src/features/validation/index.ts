/**
 * validation feature — public surface (barrel file).
 *
 * The shadow-mode dual-model validator UI split out of the Monitoring
 * tab: a toggle/status card plus the primary-detector feed annotated
 * with validator verdicts (verified / disputed / pending) and a
 * shadow-only list for catches the primary missed.
 *
 * Why human validation exists: detectors drift as conditions change
 * (new camera angles, weather, traffic patterns). A human-in-the-loop
 * feed gives an active-learning signal — disagreements between the two
 * detectors surface here so operators can label ground truth without
 * gating live alerts.
 *
 * Barrel pattern (`index.ts`): re-exports the feature's public API so
 * callers can write `import { ValidationPage } from "features/validation"`
 * instead of reaching into individual file paths. Keeps internals private.
 */
// `export { X } from "./Y"` re-exports without importing into this module.
export { ValidationPage } from "./ValidationPage";
export { useDriftCount } from "./hooks/useDriftCount";
