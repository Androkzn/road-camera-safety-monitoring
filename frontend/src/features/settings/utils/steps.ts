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
 */
import type { SettingSpec } from "../types";

/**
 * Compute a reasonable slider step for a numeric tunable.
 *
 * Priority:
 *   1. spec.step (if the schema is explicit).
 *   2. step = 1 for integer tunables.
 *   3. The largest "nice" number that still gives ≥20 stops across the range.
 *   4. 0.01 as a safety floor.
 */
export function stepFor(spec: SettingSpec, min: number, max: number): number {
  if (spec.step != null && spec.step > 0) return spec.step;
  if (spec.type === "int") return 1;
  // Guard against zero/negative ranges from malformed specs.
  const range = Math.max(max - min, 0.0001);
  const candidates = [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01];
  for (const c of candidates) {
    if (range / c >= 20) return c;
  }
  return 0.01;
}
