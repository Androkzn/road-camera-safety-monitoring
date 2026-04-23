/**
 * useIncidentState / useLastVisit — client-only "unread" state persisted
 * to localStorage.
 *
 * - useIncidentState: per-incident map (acknowledged / resolved) keyed by id.
 * - useLastVisit:     epoch-ms of last time this page was viewed; used to
 *                     badge incidents newer than the last visit.
 *
 * This is purely UI memory — the server doesn't know who acked what.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: No direct UI — backs the per-incident "acknowledged /
 *   resolved" state and the "new since last visit" badge logic that
 *   incident cards in the feed can use.
 */
// Custom hooks are plain functions whose names start with `use`. React
// enforces the "rules of hooks" on any function with that naming.
import { useCallback, useEffect, useState } from "react";

import { DELAY_MS } from "../../../shared/config/runtime";

/** Union type: an incident can be either user-acknowledged or resolved. */
export type UserStatus = "acknowledged" | "resolved";

/** One row in the persisted store. `?: string` leaves `by` optional. */
export interface StoredIncidentState {
  status: UserStatus;
  at: string;
  by?: string;
}

// `Record<K, V>` = object type whose keys are `K` and values `V`.
// Used here as a string-keyed dict of StoredIncidentState.
type Store = Record<string, StoredIncidentState>;

const STORE_KEY = "watchdog:incidentState:v1";
const VISIT_KEY = "watchdog:lastVisit:v1";

/** Read the store from localStorage, recovering from JSON/quota errors. */
function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    // `as Store` is a TS type assertion — trusts the runtime shape matches.
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

/** Serialise the store; swallow errors so a full quota never crashes UI. */
function writeStore(s: Store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/**
 * Hook returning the current store plus imperative mutators. Every
 * mutator persists synchronously — next tab reload sees the change.
 *
 * `useState<Store>(initializer)` — the function form runs once on mount,
 * so we only hit localStorage on first render, not on every re-render.
 */
export function useIncidentState() {
  const [store, setStore] = useState<Store>(() => readStore());

  // useCallback memoises the function reference between renders so any
  // child that receives it as a prop doesn't re-render unnecessarily.
  // The setState callback form `setStore(prev => …)` avoids stale closures.
  const acknowledge = useCallback((id: string, by = "operator") => {
    setStore((prev) => {
      const next: Store = {
        ...prev,
        [id]: { status: "acknowledged", at: new Date().toISOString(), by },
      };
      writeStore(next);
      return next;
    });
  }, []);

  const resolve = useCallback((id: string, by = "operator") => {
    setStore((prev) => {
      const next: Store = {
        ...prev,
        [id]: { status: "resolved", at: new Date().toISOString(), by },
      };
      writeStore(next);
      return next;
    });
  }, []);

  const reopen = useCallback((id: string) => {
    setStore((prev) => {
      const next: Store = { ...prev };
      delete next[id];
      writeStore(next);
      return next;
    });
  }, []);

  const purgeAll = useCallback(() => {
    setStore({});
    writeStore({});
  }, []);

  return { store, acknowledge, resolve, reopen, purgeAll };
}

/**
 * Snapshot the previous "last visit" epoch-ms and, after a short delay
 * (or on unload), stamp the new visit. Callers can compare incident
 * timestamps against the returned value to show "new since last visit".
 */
export function useLastVisit() {
  // Only the initial value matters — no setter is returned to the caller.
  // This snapshots the old stamp before we overwrite it below.
  const [lastVisit] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(VISIT_KEY);
      return raw ? Number(raw) : 0;
    } catch {
      return 0;
    }
  });

  // useEffect runs side effects AFTER render. Empty dep array = run once
  // on mount, and the returned function runs on unmount as cleanup.
  useEffect(() => {
    const markVisited = () => {
      try {
        localStorage.setItem(VISIT_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
    };
    // Delay the mark so very brief visits (e.g. tab flicks) don't clear
    // the "new since last visit" badges on every keystroke.
    const timer = setTimeout(markVisited, DELAY_MS.monitoringLastVisit);
    window.addEventListener("beforeunload", markVisited);
    // Cleanup: always unwind listeners/timers and stamp on the way out.
    return () => {
      clearTimeout(timer);
      window.removeEventListener("beforeunload", markVisited);
      markVisited();
    };
  }, []);

  return lastVisit;
}
