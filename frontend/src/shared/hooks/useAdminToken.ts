/**
 * useAdminToken — React hook around the sessionStorage-backed admin token.
 *
 * Returns the cached token plus setter / clearer helpers.
 *
 * Cross-tab sync: subscribes via `subscribeToAdminTokenChanges` which uses a
 * `BroadcastChannel` so setting the token in one tab is picked up by other
 * tabs in the same browser session. `sessionStorage` is per-tab, so each
 * tab still has to observe the change and call `setAdminToken` itself —
 * that's what the broadcast triggers downstream listeners to do.
 */

import { useCallback, useEffect, useState } from "react";

import {
  clearAdminToken,
  getAdminToken,
  setAdminToken,
  subscribeToAdminTokenChanges,
} from "../lib/adminApi";

export function useAdminToken(): {
  token: string | null;
  setToken: (t: string) => void;
  clear: () => void;
} {
  const [token, setTokenState] = useState<string | null>(() => getAdminToken());

  useEffect(() => {
    return subscribeToAdminTokenChanges(() => setTokenState(getAdminToken()));
  }, []);

  const setToken = useCallback((t: string) => setAdminToken(t.trim()), []);
  const clear = useCallback(() => clearAdminToken(), []);

  return { token, setToken, clear };
}
