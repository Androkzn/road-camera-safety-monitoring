/**
 * useIncidentState.ts — per-browser persisted "acknowledged/resolved" store
 * for watchdog incidents, plus a helper that tracks when the user last
 * visited the monitoring page.
 *
 * What it does:
 *   Lets the UI mark individual incidents as "acknowledged" or "resolved"
 *   (with a timestamp and an optional operator name), re-open them, or
 *   purge the whole store. The state lives in window.localStorage, so it
 *   survives page reloads but is local to each browser (not shared with
 *   the backend).
 *
 * Purpose:
 *   The backend only knows whether a problem is currently firing; it has no
 *   concept of "the operator has already seen this". This hook adds that
 *   local-only workflow state on top of the raw watchdog data.
 *
 * How it works:
 *   - localStorage.getItem/setItem reads/writes strings in the browser's
 *     per-site storage; the try/catch handles quota or private-mode errors.
 *   - useState with a "lazy initializer" — `useState(() => readStore())` —
 *     runs readStore only on first render, not on every render.
 *   - useCallback caches each state-mutating function so consumer components
 *     don't re-render every time this hook runs.
 *   - Updates use the functional setState form `setStore(prev => ...)` so
 *     rapid successive calls don't overwrite each other.
 *   - `type Store = Record<string, StoredIncidentState>` defines a map from
 *     incident id to its stored state (Record<K, V> = object with K keys,
 *     V values).
 *   - Union type `UserStatus = "acknowledged" | "resolved"` restricts the
 *     status field to those two strings.
 *   - useLastVisit() reads the last-visit timestamp once, then arranges for
 *     the current visit time to be stamped 4 seconds after mount, before
 *     unload, and on cleanup — so "new since last visit" can be computed.
 *
 * Connects to:
 *   - Backend: none — entirely client-side / localStorage.
 *   - UI: intended for use by frontend/src/pages/MonitoringPage.tsx and its
 *     incident cards (to show acknowledged/resolved chips and hide-on-ack).
 */
// React imports: useCallback memoizes a function; useEffect runs side-effects; useState re-renders on change.
import { useCallback, useEffect, useState } from "react";

// Union type: the value is exactly one of these two strings.
export type UserStatus = "acknowledged" | "resolved";

// Shape stored per incident in localStorage; `by?` is optional.
export interface StoredIncidentState {
  status: UserStatus;
  at: string;
  by?: string;
}

// `Record<K, V>` = an object type whose keys are K and values are V. Here: incidentId -> stored state.
type Store = Record<string, StoredIncidentState>;

const STORE_KEY = "watchdog:incidentState:v1";
const VISIT_KEY = "watchdog:lastVisit:v1";

// Helper: reads+parses the persisted store; returns `{}` on missing data or quota/private-mode errors.
function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

// Helper: serializes and writes the store; swallows quota/private-mode errors so the UI keeps working in memory.
function writeStore(s: Store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// useIncidentState — per-browser ack/resolve workflow on top of watchdog data.
// Consumed by: intended for frontend/src/pages/MonitoringPage.tsx and its incident cards (ack chips, hide-on-ack).
export function useIncidentState() {
  // Lazy initializer `() => readStore()` runs readStore once on first render; later renders reuse the state.
  const [store, setStore] = useState<Store>(() => readStore());

  // Mark one incident as acknowledged (default operator name "operator"). Stable identity via useCallback([]).
  const acknowledge = useCallback((id: string, by = "operator") => {
    setStore((prev) => {
      // Object spread + computed key `[id]:` creates a new object with that entry overwritten/added.
      const next: Store = { ...prev, [id]: { status: "acknowledged", at: new Date().toISOString(), by } };
      writeStore(next);
      return next;
    });
  }, []);

  // Mark one incident as resolved; same pattern as `acknowledge`.
  const resolve = useCallback((id: string, by = "operator") => {
    setStore((prev) => {
      const next: Store = { ...prev, [id]: { status: "resolved", at: new Date().toISOString(), by } };
      writeStore(next);
      return next;
    });
  }, []);

  // Re-open an incident by deleting its entry; back to "no local state" so the UI treats it as new again.
  const reopen = useCallback((id: string) => {
    setStore((prev) => {
      const next: Store = { ...prev };
      delete next[id];
      writeStore(next);
      return next;
    });
  }, []);

  // Wipe all local incident state (useful for a "forget everything" settings action).
  const purgeAll = useCallback(() => {
    setStore({});
    writeStore({});
  }, []);

  return { store, acknowledge, resolve, reopen, purgeAll };
}

// useLastVisit — returns the last-visit timestamp captured at mount (before we stamp a new one).
// Consumed by: intended for MonitoringPage / incident cards to badge "new since last visit".
export function useLastVisit() {
  // Destructure only the value (no setter needed). Lazy initializer reads localStorage once.
  const [lastVisit] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(VISIT_KEY);
      return raw ? Number(raw) : 0;
    } catch {
      return 0;
    }
  });

  // Mount-only effect (deps []): schedule stamping the current visit time and also stamp on tab close.
  // `[]` means: run exactly once when the component mounts; cleanup runs once on unmount.
  useEffect(() => {
    const markVisited = () => {
      try {
        localStorage.setItem(VISIT_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
    };
    // setTimeout delays the stamp 4s so very brief glances don't count as "visited".
    const timer = setTimeout(markVisited, 4000);
    // beforeunload fires when the user navigates away / closes the tab — stamp the visit then too.
    window.addEventListener("beforeunload", markVisited);
    // Cleanup on unmount: clear pending timer, detach listener, and stamp once more for good measure.
    return () => {
      clearTimeout(timer);
      window.removeEventListener("beforeunload", markVisited);
      markVisited();
    };
  }, []);

  return lastVisit;
}
