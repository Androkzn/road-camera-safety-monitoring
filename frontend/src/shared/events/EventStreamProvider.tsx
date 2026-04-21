/**
 * EventStreamProvider — single app-wide SSE connection to `/stream/events`.
 *
 * Why a provider, not a hook:
 *   Before D6 each page that mounted `useEventStream()` opened its own
 *   `EventSource`. Two pages visible (split-screen, two tabs) meant two
 *   connections, which meant the server fanned out every safety event
 *   twice AND the FE kept two rolling buffers that could drift. Hoisting
 *   to the provider guarantees exactly one connection and one buffer.
 *
 * Counts (D8):
 *   The previous `counts: ref.current` shape was a silent-stale-bug trap —
 *   consumers did not re-render when a count changed. Counts are now
 *   derived from `events` in the consuming hook via `useMemo`.
 *
 * Context split:
 *   Connected/status-only consumers (Monitoring page) now subscribe via
 *   `useEventStreamConnection()` so event-buffer pushes do not re-render
 *   pages that do not read `events` at all.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { LIMITS } from "../config/runtime";
import { useSSE } from "../hooks/useSSE";
import type { PerceptionState, SafetyEvent } from "../types/common";

interface EventStreamDataCtx {
  events: SafetyEvent[];
  perception: PerceptionState | null;
}

export interface EventStreamCtx {
  events: SafetyEvent[];
  perception: PerceptionState | null;
  connected: boolean;
  clearEvents: () => void;
}

interface EventStreamActionsCtx {
  clearEvents: () => void;
}

// Three separate contexts — splitting data / connection / actions means a
// consumer that only reads `connected` won't re-render when a new event
// pushes into `events`. `createContext` sets the default value used when
// a component is rendered outside the provider (tests, storybook).
const DataCtx = createContext<EventStreamDataCtx>({
  events: [],
  perception: null,
});
const ConnectionCtx = createContext(false);
const ActionsCtx = createContext<EventStreamActionsCtx>({
  clearEvents: () => {},
});

export function EventStreamProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [perception, setPerception] = useState<PerceptionState | null>(null);

  const onMessage = useCallback((msg: SafetyEvent | PerceptionState) => {
    if ("_meta" in msg && msg._meta === "perception_state") {
      setPerception(msg as PerceptionState);
      return;
    }
    const ev = msg as SafetyEvent;
    setEvents((prev) => {
      const next = [ev, ...prev];
      return next.length > LIMITS.eventStreamBuffer
        ? next.slice(0, LIMITS.eventStreamBuffer)
        : next;
    });
  }, []);

  const { connected } = useSSE<SafetyEvent | PerceptionState>({
    url: "/stream/events",
    onMessage,
  });

  const clearEvents = useCallback(() => setEvents([]), []);

  const dataValue = useMemo<EventStreamDataCtx>(
    () => ({ events, perception }),
    [events, perception],
  );
  const actionsValue = useMemo<EventStreamActionsCtx>(() => ({ clearEvents }), [clearEvents]);

  return (
    <DataCtx.Provider value={dataValue}>
      <ConnectionCtx.Provider value={connected}>
        <ActionsCtx.Provider value={actionsValue}>{children}</ActionsCtx.Provider>
      </ConnectionCtx.Provider>
    </DataCtx.Provider>
  );
}

/** Subscribe to the rolling event buffer + latest perception state. */
export function useEventStreamData(): EventStreamDataCtx {
  return useContext(DataCtx);
}

/** Subscribe ONLY to the connected flag — cheap, no event-buffer re-renders. */
export function useEventStreamConnection(): boolean {
  return useContext(ConnectionCtx);
}

/** Subscribe to stable action callbacks (clearEvents). Never re-renders on data changes. */
export function useEventStreamActions(): EventStreamActionsCtx {
  return useContext(ActionsCtx);
}

/**
 * Back-compat aggregate — returns everything in one object. Prefer the
 * split hooks above in new code so consumers only re-render on the slice
 * they actually use.
 */
export function useEventStreamCtx(): EventStreamCtx {
  const data = useEventStreamData();
  const connected = useEventStreamConnection();
  const actions = useEventStreamActions();
  return useMemo(
    () => ({
      ...data,
      connected,
      ...actions,
    }),
    [data, connected, actions],
  );
}
