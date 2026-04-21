/**
 * useHistory.ts — custom hook to load past events with risk/type filters.
 *
 * What it does:
 *   Fetches up to 200 recent SafetyEvent records from the backend,
 *   optionally filtered by risk_level and/or event_type. Exposes the
 *   current list, loading + error state, current filters, an updateFilters
 *   function that re-fetches automatically, and a manual refresh().
 *
 * Purpose:
 *   Powers the "History" tab on the admin page, where the operator browses
 *   recent events. Separates data-loading concerns from the UI component.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use` that
 *     bundles React state + side effects and returns them to the caller.
 *   - useState: stores the events list, loading flag, error string, and
 *     current filters. Changing any of these re-renders the component that
 *     called this hook.
 *   - useCallback: caches a function across renders. `load` changes only
 *     when `filters` changes, so components that depend on `load` don't
 *     re-run their effects needlessly.
 *   - updateFilters() merges a patch into the current filters with the
 *     spread operator `{ ...prev, ...patch }` and triggers a reload with
 *     the new filters immediately.
 *   - `items.reverse()` flips newest-first because the backend returns
 *     oldest-first — Array.reverse mutates in place and returns the array.
 *
 * Connects to:
 *   - Backend: GET /api/live/events (via api.getLiveEvents) — defined in
 *     road_safety/server.py, returns a list of SafetyEvent JSON objects.
 *   - UI: used by frontend/src/components/admin/HistoryPanel.tsx, which is
 *     rendered inside the History tab on the AdminPage.
 */
// React imports: useState re-renders on change; useCallback caches a function across renders.
import { useState, useCallback } from "react";
import { api } from "../lib/api";
// `type` import: shape-only, erased at build time.
import type { SafetyEvent } from "../types";

// Shape of the filter object the UI keeps; empty strings mean "no filter".
interface HistoryFilters {
  risk_level: string;
  event_type: string;
}

// useHistory — fetches GET /api/live/events with filters; returns { events, loading, error, filters, updateFilters, refresh }.
// Consumed by: frontend/src/components/admin/HistoryPanel.tsx — renders the History tab on AdminPage.
export function useHistory() {
  // Latest event list (newest first after reversal below).
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  // Spinner flag; starts true so the first render shows a loading state before the first fetch resolves.
  const [loading, setLoading] = useState(true);
  // Error message string (or null when there's no error).
  const [error, setError] = useState<string | null>(null);
  // Current filter values. Changing these triggers a reload via updateFilters below.
  const [filters, setFilters] = useState<HistoryFilters>({
    risk_level: "",
    event_type: "",
  });

  // `load` re-fetches the list. useCallback with dep [filters] means: a new function identity whenever filters change.
  // Optional arg `f?` lets callers pass explicit filters (used by updateFilters) or fall back to current state.
  // `f ?? filters` = nullish coalescing: use `f` unless it's null/undefined, then fall back to `filters`.
  const load = useCallback(async (f?: HistoryFilters) => {
    const activeFilters = f ?? filters;
    setLoading(true);
    setError(null);
    try {
      // Backend: GET /api/live/events (api.getLiveEvents wraps fetch). Empty string -> undefined so query param is omitted.
      const items = await api.getLiveEvents({
        risk_level: activeFilters.risk_level || undefined,
        event_type: activeFilters.event_type || undefined,
        limit: 200,
      });
      // Array.reverse mutates in place and returns the reversed array; backend sends oldest-first, UI wants newest-first.
      setEvents(items.reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // `updateFilters(patch)` merges a partial update into filters and immediately reloads with the merged result.
  // `Partial<T>` = same shape as T but every field is optional.
  const updateFilters = useCallback(
    (patch: Partial<HistoryFilters>) => {
      setFilters((prev) => {
        // Object spread `{ ...prev, ...patch }` = copy of prev with patch's fields overriding.
        const next = { ...prev, ...patch };
        load(next);
        return next;
      });
    },
    [load],
  );

  // `refresh` is a zero-arg wrapper around load(), suitable for a refresh button's onClick.
  return { events, loading, error, filters, updateFilters, refresh: () => load() };
}
