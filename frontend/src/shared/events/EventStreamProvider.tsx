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
 *
 * --- UI mapping ---
 * Used on: DashboardPage, MonitoringPage, AdminPage, ValidationPage —
 *   mounted once near the app root and consumed by every page that
 *   shows live events.
 * UI element: the live-event ticker that powers incident feeds,
 *   detection panels, and live tiles — this provider owns the single
 *   shared SSE buffer that every event surface reads from.
 *
 * --- Backend endpoints ---
 *  - SSE: `/stream/events` (server-sent stream of SafetyEvent payloads,
 *    interleaved with PerceptionState `_meta` frames). Reconnection and
 *    backoff are handled inside the `useSSE` hook; this provider only
 *    owns message dispatch + the in-memory buffer.
 *  - The public `/api/events/stream` and `/api/events/history` endpoints
 *    carry the same payload shape (redacted thumbnails only; plate text
 *    stripped at ingest).
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

/**
 * EventStreamProvider — mount once at the app root; children read via
 * the three split hooks below. Owns the SSE connection, rolling event
 * buffer, and the latest PerceptionState snapshot.
 *
 * Props: `children` only. No configuration — the SSE URL and buffer cap
 * are fixed so the contract stays simple.
 */
export function EventStreamProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [perception, setPerception] = useState<PerceptionState | null>(null);

  // Single dispatcher for the interleaved SSE stream. The server tags
  // perception-state frames with `_meta = "perception_state"`; everything
  // else is a SafetyEvent. Keeping this in one callback means a single
  // state-update cycle per frame.
  const onMessage = useCallback((msg: SafetyEvent | PerceptionState) => {
    if ("_meta" in msg && msg._meta === "perception_state") {
      setPerception(msg as PerceptionState);
      return;
    }
    const ev = msg as SafetyEvent;
    setEvents((prev) => {
      // Prepend so newest-first ordering is implicit; then cap at the
      // configured buffer size so long-running sessions don't leak
      // memory. Older events are dropped off the tail.
      const next = [ev, ...prev];
      return next.length > LIMITS.eventStreamBuffer
        ? next.slice(0, LIMITS.eventStreamBuffer)
        : next;
    });
  }, []);

  // useSSE owns the EventSource lifecycle: connect, auto-reconnect with
  // backoff on drop, and exposes the live connected flag we surface via
  // ConnectionCtx.
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

/**
 * useEventStreamData — subscribe to the rolling event buffer + latest
 * perception state. Re-renders on every new event; use only in
 * components that actually read `events` or `perception`.
 */
export function useEventStreamData(): EventStreamDataCtx {
  return useContext(DataCtx);
}

/**
 * useEventStreamConnection — subscribe ONLY to the connected flag. Cheap;
 * no re-render when a new event arrives. Use for status pills / banners.
 */
export function useEventStreamConnection(): boolean {
  return useContext(ConnectionCtx);
}

/**
 * useEventStreamActions — stable action callbacks (currently
 * `clearEvents`). Never re-renders on data changes, so safe to destructure
 * in effect deps.
 */
export function useEventStreamActions(): EventStreamActionsCtx {
  return useContext(ActionsCtx);
}

/**
 * useEventStreamCtx — back-compat aggregate: returns events, perception,
 * connected flag, and actions in one object. Prefer the split hooks above
 * in new code so consumers only re-render on the slice they actually use.
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
