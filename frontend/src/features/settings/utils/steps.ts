/**
 * Slider-step selection. Honours an explicit `spec.step` when set;
 * otherwise picks the largest "nice" increment (1, 0.5, 0.1, 0.05, …)
 * that yields at least 20 slider stops over the range. Keeps sliders
 * responsive without producing values like `5.0125`.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: No direct UI — helper used by the SettingsPage tunable
 *   sliders to pick a sensible step size.
 * Consumers: tunable-row slider components inside `features/settings/`
 *   that render a range-input for a numeric `SettingSpec`.
 * Backend: none — pure math over the schema from GET /api/settings/schema.
 */
import type { SettingSpec } from "../types";

/**
 * Compute a reasonable slider step for a numeric tunable.
 *
 * Params:
 *   - `spec` — the tunable's schema entry (carries optional `step` and
 *     a `type` discriminator of "int" / "float").
 *   - `min` / `max` — the effective bounds for this tunable, resolved
 *     by the caller (may be tighter than `spec.min` / `spec.max`).
 *
 * Returns a positive step size.
 *
 * Priority:
 *   1. `spec.step` (if the schema is explicit and > 0).
 *   2. step = 1 for integer tunables.
 *   3. The largest "nice" number from `[10, 5, 2, 1, 0.5, …, 0.01]` that
 *      still gives ≥20 stops across the range — keeps the slider
 *      precise enough to hit meaningful values without producing
 *      floating-point nonsense like 5.0125.
 *   4. 0.01 as a safety floor when the range is extremely small.
 *
 * Pure, synchronous; no caching needed (callers invoke per render and
 * React memoizes the calling row).
 */
export function stepFor(spec: SettingSpec, min: number, max: number): number {
  if (spec.step != null && spec.step > 0) return spec.step;
  if (spec.type === "int") return 1;
  // Guard against zero/negative ranges from malformed specs — a tiny
  // epsilon keeps the division below well-defined and forces the loop
  // to fall through to the 0.01 floor.
  const range = Math.max(max - min, 0.0001);
  const candidates = [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01];
  for (const c of candidates) {
    // Pick the FIRST (largest) candidate that still yields ≥20 stops.
    if (range / c >= 20) return c;
  }
  return 0.01;
}
