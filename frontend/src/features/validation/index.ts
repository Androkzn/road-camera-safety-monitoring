/**
 * validation — public surface of the shadow-validator feature.
 *
 * Exposes `ValidationPage` plus the `useDriftCount` hook. The feature
 * renders a shadow-mode dual-model validator UI: a toggle/status card
 * plus the primary-detector feed annotated with validator verdicts
 * (verified / disputed / pending) and a shadow-only list for catches
 * the primary missed. Barrel pattern keeps internals private.
 *
 * --- UI mapping ---
 * Page: ValidationPage ([file](frontend/src/features/validation/ValidationPage.tsx))
 * UI element: indirect; the app router lazy-loads ValidationPage via
 *              this barrel, and consumers use `useDriftCount` for
 *              drift indicators.
 */
// `export { X } from "./Y"` re-exports without importing into this module.
export { ValidationPage } from "./ValidationPage";
export { useDriftCount } from "./hooks/useDriftCount";
