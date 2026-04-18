/**
 * useAdminHealth — thin wrapper around usePolling for the admin health
 * endpoint. Polls `/api/admin/health` every `intervalMs` (default 4s).
 *
 * TEACH: A "custom hook" is any function whose name starts with `use*` and
 * that may call other hooks. This file is the simplest possible example:
 * it's literally one other hook call. Still worth having as its own hook
 * because it (a) centralises the interval choice, (b) gives the call site
 * a semantic name (`useAdminHealth()` reads better than a raw polling
 * call), and (c) lets us swap the underlying transport later without
 * touching consumers.
 *
 * Return shape:
 *   Whatever usePolling returns: { data, error, refetch }.
 *
 * Consumers:
 *   - pages/AdminPage.tsx  (`const { data: health } = useAdminHealth();`)
 *
 * See hooks/usePolling.ts for the first teaching of useState / useEffect /
 * useRef / useCallback / cleanup.
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useAdminHealth(intervalMs = 4000) {
  return usePolling({
    // `api.getAdminHealth` is defined in lib/api.ts and calls `fetchJSON`
    // against the admin endpoint. It requires the `Authorization: Bearer`
    // token header which `api` attaches automatically.
    fetcher: api.getAdminHealth,
    intervalMs,
  });
}
