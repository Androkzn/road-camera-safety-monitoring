/**
 * useHistory — loads a filtered slice of `/api/live/events` on demand
 * for the Admin "history" panel. No auto-refresh — caller drives loads
 * via `updateFilters(patch)` or `refresh()`.
 *
 * Why this is NOT built on TanStack Query: the page owns its own
 * filter state and the loading behaviour is "fire on filter-change".
 * A plain `useState + useCallback` fetch is easier to reason about for
 * this one-off pattern than wiring `useQuery` with dependent keys.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the data hook behind the
 *   "History" tab's list of past events and its risk-level / event-type
 *   filter dropdowns.
 * Backend: GET /api/live/events.
 */
import { useState, useCallback } from "react";

import { LIMITS } from "../../../shared/config/runtime";
import { adminApi } from "../api";
import type { SafetyEvent } from "../../../shared/types/common";

// TEACH: `interface` declares the shape of the filter object. Empty
// string = "no filter applied". Using `""` as a sentinel keeps the
// controlled <select> happy (a controlled select's value must be a
// string, never `undefined`).
interface HistoryFilters {
  risk_level: string;
  event_type: string;
}

/**
 * Load + filter + refresh state machine for the history panel.
 * Returns current events, loading/error flags, the filters object, and
 * two callbacks (`updateFilters`, `refresh`) for the consumer.
 */
export function useHistory() {
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<HistoryFilters>({
    risk_level: "",
    event_type: "",
  });

  // TEACH: `useCallback(fn, deps)` returns a memoised version of `fn`.
  // It only changes when something in `deps` changes. Keeps dependent
  // effects/memoised children from re-running unnecessarily.
  const load = useCallback(
    async (f?: HistoryFilters) => {
      const activeFilters = f ?? filters;
      setLoading(true);
      setError(null);
      try {
        const items = await adminApi.getLiveEvents({
          // Empty-string → undefined so the API wrapper omits the param.
          risk_level: activeFilters.risk_level || undefined,
          event_type: activeFilters.event_type || undefined,
          limit: LIMITS.liveEventsDefaultLimit,
        });
        setEvents(items.reverse());
      } catch (err) {
        // `err` is typed `unknown`; narrow with `instanceof Error`
        // before touching `.message`.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  // TEACH: `Partial<T>` makes every field of T optional — so callers can
  // pass just one key at a time (e.g. only change `risk_level`).
  const updateFilters = useCallback(
    (patch: Partial<HistoryFilters>) => {
      setFilters((prev) => {
        const next = { ...prev, ...patch };
        load(next);
        return next;
      });
    },
    [load],
  );

  // TEACH: The `void` operator discards a returned Promise — silences
  // the "floating promise" lint without awaiting inside a non-async fn.
  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return {
    events,
    loading,
    error,
    filters,
    updateFilters,
    refresh,
  };
}
