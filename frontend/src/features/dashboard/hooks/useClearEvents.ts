/**
 * useClearEvents — encapsulates the "clear all events + watchdog findings"
 * workflow so the page component stays a composition shell.
 *
 * Queries/mutations: no TanStack Query; hand-rolled mutation via apiFetch
 *   (DELETE). Local-event state cleanup (clearEvents) and watchdog
 *   cleanup (clearAllFindings) are injected as callbacks so this hook
 *   stays agnostic of which stores/contexts own that data.
 *
 * Flow:
 *   1. Open a confirmation dialog (variant: "danger").
 *   2. On confirm: DELETE /api/events to wipe the server-side in-memory
 *      event buffer.
 *   3. Invoke clearEvents() to flush the frontend's local event store.
 *   4. If there are watchdog findings, await clearAllFindings() too.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — drives the "Clear all events" button at the
 *   right end of the filter bar above the event feed.
 * Consumer: DashboardPage imports this and wires `{ clear, clearing }` into
 *   the filter bar's clear button (disabled while `clearing` is true).
 * Backend: DELETE /api/events — server returns `{ cleared: number }` (count
 *   of events removed from the in-memory buffer). No persistence is
 *   affected; audit log is untouched by design.
 */
import { useCallback, useState } from "react";

import { apiFetch } from "../../../shared/lib/fetchClient";
import { useDialog } from "../../../shared/ui";

/**
 * Dependencies injected by the page:
 * - clearEvents: sync callback that wipes the frontend-local event list
 *   (usually setter from a useState / zustand store).
 * - clearAllFindings: async callback that clears watchdog findings
 *   (awaited so the spinner stays on until both are done).
 * - hasFindings: drives both the dialog copy and whether we bother
 *   calling clearAllFindings at all.
 */
interface UseClearEventsOpts {
  clearEvents: () => void;
  clearAllFindings: () => Promise<void>;
  hasFindings: boolean;
}

/**
 * Returns `{ clear, clearing }`.
 *   - `clear()`: async — opens confirmation dialog, DELETEs `/api/events`,
 *     then invokes the injected cleanup callbacks. Resolves either way.
 *   - `clearing`: boolean — true from DELETE start until both cleanups
 *     finish. Use it to disable the trigger button.
 *
 * Error behaviour: errors from apiFetch or clearAllFindings are NOT
 *   caught here — they propagate to React's nearest error boundary. The
 *   `finally` block guarantees `clearing` is reset so the UI never
 *   locks on failure. No toast/dialog on failure in this hook.
 *
 * Cache/staleness: N/A (imperative mutation). `clear` identity changes
 *   if any dependency changes (useCallback deps below).
 */
export function useClearEvents({ clearEvents, clearAllFindings, hasFindings }: UseClearEventsOpts) {
  const [clearing, setClearing] = useState(false);
  const dialog = useDialog();

  const clear = useCallback(async () => {
    // Dialog copy varies with state: mention watchdog findings only if
    // they actually exist, so the user isn't warned about data they
    // don't have.
    const ok = await dialog.confirm({
      title: "Clear all events?",
      message: hasFindings
        ? "This wipes the event feed and all watchdog findings. The action is local and can't be undone."
        : "This wipes the event feed. The action is local and can't be undone.",
      okLabel: "Clear all",
      cancelLabel: "Cancel",
      variant: "danger",
    });
    // User hit Cancel / dismissed: bail before touching any state.
    if (!ok) return;
    setClearing(true);
    try {
      // Server-side wipe first. Response `{ cleared: number }` is
      // currently ignored — the UI only cares that it succeeded.
      await apiFetch<{ cleared: number }>("/api/events", {
        method: "DELETE",
      });
      // Clear the frontend-local store next, so it's always in sync
      // with the server (otherwise the SSE-driven list would still
      // show cached events until the next stream event).
      clearEvents();
      // Only hit the watchdog path when there's something to clear;
      // avoids a redundant request on a clean slate.
      if (hasFindings) {
        await clearAllFindings();
      }
    } finally {
      // Always release the clearing flag so the button unfreezes even
      // if DELETE / clearAllFindings threw.
      setClearing(false);
    }
  }, [clearEvents, clearAllFindings, hasFindings, dialog]);

  return { clear, clearing };
}
