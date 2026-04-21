/**
 * useSSE — generic Server-Sent Events subscription hook.
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

interface UseSSEOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  enabled?: boolean;
}

/**
 * Generic SSE subscription. `T` is the shape of parsed JSON messages.
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
    if (!enabled) return;

    let backoff: number = SSE_BACKOFF.initialMs;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let es: EventSource | null = null;

    function connect() {
      if (stopped) return;
      try {
        es = new EventSource(url);
        es.onopen = () => {
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
            timer = setTimeout(connect, backoff);
            backoff = Math.min(backoff * SSE_BACKOFF.multiplier, SSE_BACKOFF.maxMs);
          }
        };
      } catch {
        setConnected(false);
        if (!stopped) {
          timer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * SSE_BACKOFF.multiplier, SSE_BACKOFF.maxMs);
        }
      }
    }

    connect();
    return () => {
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
