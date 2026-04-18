/**
 * useIncidentState / useLastVisit — client-only "unread" state persisted
 * to localStorage for the Monitoring page.
 *
 * Why two hooks in one file:
 *   - `useIncidentState` — per-incident status map
 *     (acknowledged / resolved) keyed by finding id.
 *   - `useLastVisit` — epoch-ms of the last time the user viewed the page,
 *     used to badge incidents newer than the last visit.
 * They share the same persistence pattern (localStorage get/set with
 * try/catch) so they live together.
 *
 * TEACH: A "custom hook" is any `use*` function that may call other hooks.
 * Both of these are custom hooks, illustrating two common patterns:
 *   - keeping a piece of UI state in sync with localStorage
 *   - using a useEffect to subscribe/unsubscribe to DOM events
 *     (`beforeunload`) — with a cleanup that removes the listener.
 *
 * Return shapes:
 *   useIncidentState → { store, acknowledge, resolve, reopen, purgeAll }
 *   useLastVisit     → number (epoch ms, 0 if never visited)
 *
 * Consumers:
 *   - pages/MonitoringPage.tsx (both hooks)
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

// Plain helpers — kept module-local so hooks stay focused. The try/catch
// around localStorage guards against Safari private-mode / disabled storage
// (localStorage can throw QuotaExceededError, SecurityError, etc.).
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
  // --- Local state with LAZY initial value ---
  // TEACH: Note the `() => readStore()` form. Passing a FUNCTION to
  // useState means React calls it only on the first render — so we don't
  // hit localStorage (a sync disk-ish read) on every re-render. If we
  // had written `useState(readStore())`, the read would happen every
  // render (the result would be ignored after mount, but the read still
  // runs). Always use the lazy form for initial values that involve I/O
  // or non-trivial computation.
  const [store, setStore] = useState<Store>(() => readStore());

  // TEACH: useCallback with `[]` deps = stable identity for the life of
  // the component. Safe here because the updater closures only use the
  // setter + the `prev` argument; they don't reference any other state.
  const acknowledge = useCallback((id: string, by = "operator") => {
    setStore((prev) => {
      // Functional updater: produce next map from prev. We write-through
      // to localStorage inside the updater so storage is always in sync
      // with the committed state.
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
  // Read the stored "last visited" timestamp ONCE, on mount. We discard
  // the setter via `[lastVisit]` because the value we want to return is a
  // snapshot of "last visit BEFORE this session" — if we updated it live
  // we'd lose the "unread since" semantic.
  const [lastVisit] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(VISIT_KEY);
      return raw ? Number(raw) : 0;
    } catch {
      return 0;
    }
  });

  // --- Effect: mark the page as visited ---
  // TEACH: useEffect with `[]` deps runs once on mount and its cleanup
  // runs once on unmount. This is the idiomatic "subscribe / unsubscribe"
  // shape. Here we:
  //   - set a 4s timer to mark the visit (if they linger)
  //   - listen for `beforeunload` to mark it if they navigate away first
  //   - also mark on unmount (e.g. route change inside the SPA)
  // The cleanup MUST remove the same listener reference it added;
  // `window.removeEventListener("beforeunload", markVisited)` works
  // because `markVisited` is a stable reference inside this effect run.
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
