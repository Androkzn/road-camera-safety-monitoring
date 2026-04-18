/**
 * useLiveStatus — polls `/api/live/status` every `intervalMs` (default 5s)
 * for the current stream/ingest status the dashboard displays.
 *
 * TEACH: Like useAdminHealth, this is a "named wrapper" around usePolling.
 * A custom hook is any `use*` function that may call other hooks; composing
 * hooks this way (small specific hook on top of a generic one) is idiomatic
 * React — it keeps the generic primitive reusable and gives call sites a
 * self-documenting name.
 *
 * Return shape:
 *   usePolling's return: { data, error, refetch }.
 *
 * Consumers:
 *   - pages/DashboardPage.tsx
 *   - pages/MonitoringPage.tsx
 *
 * See hooks/usePolling.ts for useState / useEffect / useRef / useCallback.
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useLiveStatus(intervalMs = 5000) {
  return usePolling({
    fetcher: api.getLiveStatus, // lib/api.ts::fetchJSON wrapper
    intervalMs,
  });
}
