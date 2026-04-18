/**
 * useHistory — loads a filtered slice of `/api/live/events` on demand and
 * manages filter state for the Admin "history" panel.
 *
 * Unlike the polling hooks, this one does NOT auto-refresh. Callers drive
 * loads explicitly via `updateFilters(patch)` (for filter changes) or
 * `refresh()` (for a manual reload).
 *
 * TEACH: A "custom hook" is just a function starting with `use*` that can
 * call other hooks. Packaging filter state + fetch logic + derived
 * `loading`/`error` together here keeps HistoryPanel.tsx focused on
 * rendering.
 *
 * Return shape:
 *   {
 *     events,         // SafetyEvent[], reversed so OLDEST is first
 *     loading,        // true during a fetch
 *     error,          // last error message or null
 *     filters,        // current { risk_level, event_type }
 *     updateFilters,  // patch filters + auto-reload
 *     refresh,        // manual reload with current filters
 *   }
 *
 * Consumers:
 *   - components/admin/HistoryPanel.tsx
 */
import { useState, useCallback } from "react";
import { api } from "../lib/api";
import type { SafetyEvent } from "../types";

interface HistoryFilters {
  risk_level: string;
  event_type: string;
}

export function useHistory() {
  // --- Local state ---
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  // Starts `true` so the panel shows a loading state even before first
  // fetch — the HistoryPanel triggers `refresh()` on mount.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<HistoryFilters>({
    risk_level: "",
    event_type: "",
  });

  // --- load(): fetch with optional filter override ---
  // TEACH: useCallback here is important because `load` is used as a dep
  // of `updateFilters` below. If `load` changed identity every render,
  // `updateFilters` would also change every render, which would cascade
  // through any child components that use it in their own effect deps.
  const load = useCallback(async (f?: HistoryFilters) => {
    // Default to the filters currently in state — but callers can pass an
    // override `f`, which `updateFilters` does to avoid the "set-state is
    // async, so `filters` hasn't updated yet" race.
    const activeFilters = f ?? filters;
    setLoading(true);
    setError(null);
    try {
      const items = await api.getLiveEvents({
        risk_level: activeFilters.risk_level || undefined,
        event_type: activeFilters.event_type || undefined,
        limit: 200,
      });
      // Server returns newest-first; the panel wants oldest-first for
      // chronological display.
      setEvents(items.reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // Deps include `filters` because we default to reading it. This does
    // mean `load`'s identity changes whenever filters change — acceptable
    // because `updateFilters` already rebuilds on the same trigger.
  }, [filters]);

  // --- updateFilters(): patch + reload atomically ---
  // TEACH: The functional-updater form `setFilters(prev => ...)` is doing
  // two jobs here: (1) computing the new filter object from the latest
  // committed state, and (2) firing the fetch with the NEW filters (not
  // the stale `filters` closure variable). Calling `load(next)` from
  // inside the updater sidesteps the React rule that setState is async —
  // we pass the next value explicitly instead of hoping state has caught
  // up by the time `load` runs.
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

  // `refresh` intentionally calls `load()` with no arg so it uses whatever
  // filters are currently in state. Defined inline (no useCallback) because
  // nothing in this return value chain depends on its identity.
  return { events, loading, error, filters, updateFilters, refresh: () => load() };
}
