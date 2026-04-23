/**
 * useSSE — generic Server-Sent Events subscription hook.
 *
 * Endpoint: any EventSource URL (e.g. `/api/events/stream`). Generic over
 * the parsed message type `T`. This module intentionally has no
 * domain knowledge — EventStreamProvider wraps it for the SafetyEvent feed.
 *
 * Downstream consumers: EventStreamProvider (the only direct consumer);
 * pages read the shared buffer via useEventStream / useEventStreamCtx.
 *
 * SSE doesn't fit into TanStack Query (it's a long-lived push channel,
 * not a pull). This hook owns the EventSource lifecycle: open on mount,
 * exponential-backoff reconnect on error, close on unmount.
 *
 * --- UI mapping ---
 * Used on: DashboardPage, MonitoringPage, AdminPage (via the app-wide
 *   EventStreamProvider, which is the only direct consumer).
 * UI element: the live-event ticker that powers incident feeds,
 *   detection panels, and live tiles — this hook is the underlying
 *   network plumbing, not a visible element on its own.
 */
import { useEffect, useRef, useState } from "react";

import { SSE_BACKOFF } from "../config/runtime";

// Options for useSSE:
//   - url:       EventSource URL to connect to.
//   - onMessage: called once per successfully-parsed message of type T.
//   - enabled:   gate to pause/resume the connection (default true).
interface UseSSEOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  enabled?: boolean;
}

/**
 * Generic SSE subscription. `T` is the shape of parsed JSON messages.
 *
 * Params: UseSSEOptions<T> — { url, onMessage, enabled? }.
 * Returns: { connected: boolean } — live connection status for UI pills.
 * Side effects: opens an EventSource on mount / url change / enable flip;
 *   schedules reconnect timers; closes the socket on unmount.
 *
 * How it works:
 *   - `useRef` holds the latest `onMessage` so the effect below does NOT
 *     depend on it — otherwise every parent re-render would tear down
 *     and reconnect the EventSource.
 *   - `useState` tracks connection status (re-renders callers on flip).
 *   - `useEffect` owns the EventSource lifecycle; the returned function
 *     is the cleanup that runs on unmount / dep change.
 */
export function useSSE<T>({ url, onMessage, enabled = true }: UseSSEOptions<T>) {
  // Stable ref — mutated on every render so the effect always sees the
  // latest handler without needing it in the dep array.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Gate: let callers disable the subscription without unmounting.
    if (!enabled) return;

    // Exponential backoff state, scoped to this effect run so a URL change
    // or remount starts from the initial delay, not a stale long wait.
    let backoff: number = SSE_BACKOFF.initialMs;
    let timer: ReturnType<typeof setTimeout>;
    // `stopped` flag prevents a pending setTimeout from re-opening a socket
    // after the cleanup has already run (classic race on fast unmount).
    let stopped = false;
    let es: EventSource | null = null;

    function connect() {
      if (stopped) return;
      try {
        es = new EventSource(url);
        es.onopen = () => {
          // Successful open resets the backoff so the next failure starts
          // from the initial delay rather than the last capped value.
          backoff = SSE_BACKOFF.initialMs;
          setConnected(true);
        };
        es.onmessage = (ev) => {
          try {
            onMessageRef.current(JSON.parse(ev.data) as T);
          } catch {
            /* ignore parse errors — keep the stream healthy */
          }
        };
        es.onerror = () => {
          setConnected(false);
          try {
            es?.close();
          } catch {
            /* noop */
          }
          es = null;
          if (!stopped) {
            // Schedule reconnect, then grow the backoff (capped at maxMs)
            // so repeated failures back off to a sane upper bound.
            timer = setTimeout(connect, backoff);
            backoff = Math.min(backoff * SSE_BACKOFF.multiplier, SSE_BACKOFF.maxMs);
          }
        };
      } catch {
        // EventSource constructor threw (e.g. invalid URL) — treat like
        // a transport error and retry with the same backoff schedule.
        setConnected(false);
        if (!stopped) {
          timer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * SSE_BACKOFF.multiplier, SSE_BACKOFF.maxMs);
        }
      }
    }

    connect();
    return () => {
      // Cleanup on unmount / url change / enabled flip: stop any pending
      // reconnect AND close the live socket so we leave no orphan handles.
      stopped = true;
      clearTimeout(timer);
      try {
        es?.close();
      } catch {
        /* noop */
      }
      es = null;
      setConnected(false);
    };
  }, [url, enabled]);

  return { connected };
}
