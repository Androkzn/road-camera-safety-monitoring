/**
 * useSSE.ts — generic Server-Sent Events (SSE) subscription hook with
 * automatic reconnect and exponential backoff.
 *
 * What it does:
 *   Given a URL and an onMessage callback, opens an EventSource to that
 *   URL, parses each incoming JSON message, and forwards the parsed object
 *   to the callback. If the connection drops, it waits (starting at 2s,
 *   growing up to 30s) and retries. Returns { connected } so the UI can
 *   show a live/offline indicator.
 *
 * Purpose:
 *   SSE is the one-way streaming protocol the backend uses to push real-
 *   time events to the browser (vs. polling). Centralizing connect/parse/
 *   retry logic here keeps the event-specific hooks tiny.
 *
 * How it works:
 *   - EventSource is a browser built-in that holds an open HTTP connection
 *     and fires `onmessage` for every "data: ..." line the server writes.
 *   - This is a "custom hook": a reusable function starting with `use`.
 *   - Generics: `useSSE<T>` — <T> is a placeholder type the caller fills in
 *     (e.g. useSSE<SafetyEvent | PerceptionState>), so `data` handed to
 *     onMessage is typed correctly.
 *   - useRef: holds the latest `onMessage` callback without causing re-
 *     renders; the effect always reads onMessageRef.current so stale
 *     closures don't call an old version of the callback.
 *   - useState tracks the `connected` boolean for display.
 *   - useEffect: opens the connection on mount, returns a cleanup function
 *     that stops reconnection attempts and closes the EventSource on
 *     unmount or when `url`/`enabled` change.
 *   - Exponential backoff: after each error the retry delay grows by 1.5x
 *     up to a 30s cap, then resets when the connection opens successfully.
 *
 * Connects to:
 *   - Backend: any SSE endpoint — callers point it at
 *     /stream/events (see useEventStream) or /admin/detections (see
 *     useDetections), both defined in road_safety/server.py.
 *   - UI: used internally by useEventStream.ts and useDetections.ts.
 */
// React imports: useEffect runs side-effects; useRef is a mutable box that survives renders; useState re-renders on change.
import { useEffect, useRef, useState } from "react";

// Options shape with generic <T>: <T> is a placeholder type the caller fills in so `onMessage` receives the right shape.
interface UseSSEOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  enabled?: boolean;
}

// useSSE — generic SSE subscription primitive; returns { connected } for UI indicators.
// Building block used by useEventStream (events feed) and useDetections (detection frames).
export function useSSE<T>({ url, onMessage, enabled = true }: UseSSEOptions<T>) {
  // Keep latest onMessage in a ref so reconnects use the newest callback without re-opening the stream on every render.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // `connected` drives "Live" vs "Reconnecting" pills in the UI; flips on EventSource onopen/onerror.
  const [connected, setConnected] = useState(false);

  // Effect opens the EventSource and sets up auto-reconnect. Deps [url, enabled] means:
  // re-run (tear down + reopen) whenever url or enabled changes. Returned function cleans up on unmount.
  useEffect(() => {
    if (!enabled) return;

    // Reconnect backoff starts at 2s and grows to 30s; `stopped` guards against reconnects after cleanup.
    let backoff = 2000;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let es: EventSource | null = null;

    // Inner helper that opens one EventSource and schedules the next retry on failure.
    function connect() {
      if (stopped) return;
      try {
        // EventSource = browser API that holds an open HTTP connection and emits server-pushed messages (SSE).
        es = new EventSource(url);

        // onopen fires when the stream is live; reset the backoff and flip the UI to "connected".
        es.onopen = () => {
          backoff = 2000;
          setConnected(true);
        };

        // onmessage fires for each "data: ..." line; parse JSON and hand it to the latest onMessage callback.
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as T;
            onMessageRef.current(data);
          } catch {
            /* ignore parse errors */
          }
        };

        // onerror fires on any dropped connection; close, mark offline, schedule a retry with backoff.
        es.onerror = () => {
          setConnected(false);
          try { es?.close(); } catch { /* noop */ }
          es = null;
          if (!stopped) {
            // setTimeout schedules a one-shot retry; cleanup (below) clears it if we unmount in between.
            timer = setTimeout(connect, backoff);
            backoff = Math.min(backoff * 1.5, 30000);
          }
        };
      } catch {
        setConnected(false);
        if (!stopped) {
          timer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 1.5, 30000);
        }
      }
    }

    connect();

    // Cleanup runs on unmount or before the effect re-runs: stop reconnects, cancel pending retry, close stream.
    return () => {
      stopped = true;
      clearTimeout(timer);
      try { es?.close(); } catch { /* noop */ }
      es = null;
      setConnected(false);
    };
  }, [url, enabled]);

  return { connected };
}
