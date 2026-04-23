/**
 * AppProviders — single composition root for cross-cutting providers.
 *
 * Order matters:
 *   1. QueryClientProvider  — every feature hook reads its cache.
 *   2. BrowserRouter        — react-router context for <Link>/<Route>.
 *   3. WatchdogProvider     — depends on QueryClient (uses TanStack Query).
 *   4. EventStreamProvider  — single app-wide SSE connection to
 *                             `/stream/events`, consumed by every page
 *                             via `useEventStreamCtx()` (D6: stops
 *                             per-page `EventSource` duplication).
 *   5. DialogProvider       — exposes themed alert/confirm to every
 *                             descendant (and to non-component callers
 *                             via the `dialog` singleton).
 *
 * --- UI mapping ---
 * Scope: app-wide (affects every page)
 * UI element: no visible element — wraps every page with shared providers (React Query cache, event stream, watchdog context)
 */
import type { ReactNode } from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";

import { EventStreamProvider } from "../shared/events";
import { queryClient } from "../shared/lib/queryClient";
import { DialogProvider } from "../shared/ui";
import { WatchdogProvider } from "../features/watchdog";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <WatchdogProvider>
          <EventStreamProvider>
            <DialogProvider>{children}</DialogProvider>
          </EventStreamProvider>
        </WatchdogProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
