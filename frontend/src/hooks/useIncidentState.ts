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
import { useCallback, useEffect, useState } from "react";

export type UserStatus = "acknowledged" | "resolved";

export interface StoredIncidentState {
  status: UserStatus;
  at: string;
  by?: string;
}

type Store = Record<string, StoredIncidentState>;

const STORE_KEY = "watchdog:incidentState:v1";
const VISIT_KEY = "watchdog:lastVisit:v1";

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(s: Store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function useIncidentState() {
  const [store, setStore] = useState<Store>(() => readStore());

  const acknowledge = useCallback((id: string, by = "operator") => {
    setStore((prev) => {
      const next: Store = { ...prev, [id]: { status: "acknowledged", at: new Date().toISOString(), by } };
      writeStore(next);
      return next;
    });
  }, []);

  const resolve = useCallback((id: string, by = "operator") => {
    setStore((prev) => {
      const next: Store = { ...prev, [id]: { status: "resolved", at: new Date().toISOString(), by } };
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

export function useLastVisit() {
  const [lastVisit] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(VISIT_KEY);
      return raw ? Number(raw) : 0;
    } catch {
      return 0;
    }
  });

  useEffect(() => {
    const markVisited = () => {
      try {
        localStorage.setItem(VISIT_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(markVisited, 4000);
    window.addEventListener("beforeunload", markVisited);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("beforeunload", markVisited);
      markVisited();
    };
  }, []);

  return lastVisit;
}
