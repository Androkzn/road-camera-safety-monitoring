/**
 * useClearEvents — encapsulates the "clear all events + watchdog findings"
 * workflow so the page component stays a composition shell.
 */
import { useCallback, useState } from "react";

import { adminFetch } from "../../../shared/lib/adminApi";
import { useDialog } from "../../../shared/ui";

interface UseClearEventsOpts {
  clearEvents: () => void;
  clearAllFindings: () => Promise<void>;
  hasFindings: boolean;
}

export function useClearEvents({ clearEvents, clearAllFindings, hasFindings }: UseClearEventsOpts) {
  const [clearing, setClearing] = useState(false);
  const dialog = useDialog();

  const clear = useCallback(async () => {
    const ok = await dialog.confirm({
      title: "Clear all events?",
      message: hasFindings
        ? "This wipes the event feed and all watchdog findings. The action is local and can't be undone."
        : "This wipes the event feed. The action is local and can't be undone.",
      okLabel: "Clear all",
      cancelLabel: "Cancel",
      variant: "danger",
    });
    if (!ok) return;
    setClearing(true);
    try {
      await adminFetch<{ cleared: number }>("/api/events", {
        method: "DELETE",
      });
      clearEvents();
      if (hasFindings) {
        await clearAllFindings();
      }
    } finally {
      setClearing(false);
    }
  }, [clearEvents, clearAllFindings, hasFindings, dialog]);

  return { clear, clearing };
}
