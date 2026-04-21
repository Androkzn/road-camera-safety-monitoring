/**
 * useDriftCount — number of validator (shadow-model) findings where the
 * second detector disagreed with the first: false-positive, classification
 * mismatch, or false-negative (shadow-only detection).
 *
 * Drives the red bubble on the Validation nav link. Reads from the
 * watchdog context so every tab shares one query / one cache.
 *
 * This is a "custom hook" — any function whose name starts with `use`
 * and which calls React hooks internally. Custom hooks let us package
 * reusable stateful logic and share it across components.
 */
import { useMemo } from "react";

import { useWatchdogCtx } from "../../watchdog";

/**
 * Hook returning the count of validator-category watchdog findings.
 *
 * @returns number of current drift findings (never negative).
 */
export function useDriftCount(): number {
  // Consume shared watchdog context instead of hitting the API again —
  // one network query, many consumers.
  const { findings } = useWatchdogCtx();
  // Memoize so downstream components re-render only when the count
  // value itself could have changed.
  return useMemo(
    () => (findings ?? []).filter((f) => f.category === "validator").length,
    [findings],
  );
}
