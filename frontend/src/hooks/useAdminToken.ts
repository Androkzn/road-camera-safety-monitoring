/**
 * useAdminToken — React hook around the sessionStorage-backed admin token.
 *
 * Returns the cached token plus setter / clearer helpers. Listens for the
 * "admin-token-changed" custom event so two SettingsPage instances open in
 * different tabs (or the TopBar header, one day) stay in sync.
 */

import { useCallback, useEffect, useState } from "react";

import {
  clearAdminToken,
  getAdminToken,
  setAdminToken,
} from "../lib/adminApi";

export function useAdminToken(): {
  token: string | null;
  setToken: (t: string) => void;
  clear: () => void;
} {
  const [token, setTokenState] = useState<string | null>(() => getAdminToken());

  useEffect(() => {
    const onChange = () => setTokenState(getAdminToken());
    window.addEventListener("admin-token-changed", onChange);
    // sessionStorage events don't fire in the same tab; the custom event
    // covers both same-tab and cross-tab via the dispatch in adminApi.ts.
    return () => window.removeEventListener("admin-token-changed", onChange);
  }, []);

  const setToken = useCallback((t: string) => setAdminToken(t.trim()), []);
  const clear = useCallback(() => clearAdminToken(), []);

  return { token, setToken, clear };
}
