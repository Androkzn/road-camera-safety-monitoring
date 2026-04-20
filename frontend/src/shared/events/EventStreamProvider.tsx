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
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useSSE } from "../hooks/useSSE";
import type { PerceptionState, SafetyEvent } from "../types/common";

const MAX_EVENTS = 100;

export interface EventStreamCtx {
  events: SafetyEvent[];
  perception: PerceptionState | null;
  connected: boolean;
  clearEvents: () => void;
}

const Ctx = createContext<EventStreamCtx>({
  events: [],
  perception: null,
  connected: false,
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
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  const { connected } = useSSE<SafetyEvent | PerceptionState>({
    url: "/stream/events",
    onMessage,
  });

  const clearEvents = useCallback(() => setEvents([]), []);

  const value = useMemo<EventStreamCtx>(
    () => ({ events, perception, connected, clearEvents }),
    [events, perception, connected, clearEvents],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEventStreamCtx(): EventStreamCtx {
  return useContext(Ctx);
}
