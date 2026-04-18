/**
 * useScene — polls `/api/scene` every `intervalMs` (default 7s) for the
 * current scene classification (urban / highway / parking) the dashboard
 * shows as a badge.
 *
 * TEACH: Another thin named wrapper around usePolling. A custom hook is a
 * `use*` function that may call other hooks — composing a specific hook on
 * top of a generic one is the standard way to reuse data-fetching logic
 * without leaking the interval choice into every call site.
 *
 * Return shape: usePolling's { data, error, refetch }.
 *
 * Consumers:
 *   - pages/DashboardPage.tsx
 *
 * See hooks/usePolling.ts for the first teaching of each React primitive.
 */
import { api } from "../lib/api";
import { usePolling } from "./usePolling";

export function useScene(intervalMs = 7000) {
  return usePolling({
    fetcher: api.getScene, // lib/api.ts
    intervalMs,
  });
}
