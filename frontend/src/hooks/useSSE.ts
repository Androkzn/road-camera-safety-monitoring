/**
 * useSSE — generic Server-Sent Events subscription custom hook.
 *
 * TEACH: "SSE" (Server-Sent Events) is a browser API for a one-way stream
 * from server to client over plain HTTP. Unlike WebSockets, SSE is
 * unidirectional (server → client), it auto-reconnects when the socket
 * drops, and it's exposed through the global `EventSource` class:
 *   const es = new EventSource(url);
 *   es.onopen    = () => {...};  // connection established
 *   es.onmessage = (ev) => {...}; // ev.data is a string (usually JSON)
 *   es.onerror   = () => {...};  // disconnect / HTTP error
 *   es.close();                   // tear down
 * You can also `es.addEventListener("named-event", handler)` for
 * server-named events; here we only use the default "message" event.
 *
 * TEACH: A "custom hook" is just a function starting with `use*` that may
 * call other hooks. It lets components share stateful logic. This one hides
 * all the EventSource bookkeeping (open, parse, reconnect with backoff,
 * close on unmount) behind a one-line call site.
 *
 * Return shape:
 *   { connected } — a boolean reactive flag components can render as a
 *                   "live" dot. The actual events are delivered via the
 *                   `onMessage` callback the caller passed in.
 *
 * Consumers:
 *   - hooks/useEventStream.ts     (safety events + perception state)
 *   - hooks/useDetections.ts      (per-frame detection snapshots)
 *
 * React concepts: see usePolling.ts for useState / useRef / useEffect /
 * cleanup. This file additionally shows how to wrap a browser subscription
 * API safely — "always close in the cleanup, never subscribe twice".
 */
import { useEffect, useRef, useState } from "react";

interface UseSSEOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  enabled?: boolean;
}

export function useSSE<T>({ url, onMessage, enabled = true }: UseSSEOptions<T>) {
  // --- "Latest onMessage" ref ---
  // TEACH: Same stale-closure pattern as in usePolling. Callers typically
  // write `onMessage: (msg) => setFoo(msg)` inline, producing a fresh
  // function every render. If we put that into the effect's deps we'd tear
  // down and rebuild the EventSource on every render — yanking the live
  // connection. Instead we park the latest callback in a ref and call
  // `onMessageRef.current(...)` from the handler, keeping the subscription
  // itself tied only to `url` + `enabled`.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // --- Local state: connection indicator ---
  const [connected, setConnected] = useState(false);

  // --- Effect: open/maintain/close the EventSource ---
  useEffect(() => {
    if (!enabled) return;

    // Exponential-backoff reconnect, capped at 30s.
    let backoff = 2000;
    let timer: ReturnType<typeof setTimeout>;
    // `stopped` flag: prevents a pending reconnect timer (scheduled from
    // onerror) from firing AFTER this effect has been cleaned up. Without
    // it we'd race: cleanup runs, then the timer fires, then `connect()`
    // opens a fresh EventSource that nobody owns — a classic leak.
    let stopped = false;
    let es: EventSource | null = null;

    function connect() {
      if (stopped) return;
      try {
        es = new EventSource(url);

        es.onopen = () => {
          // On a successful open, reset backoff so the NEXT disconnect
          // retries quickly instead of inheriting a long delay from the
          // previous failure chain.
          backoff = 2000;
          setConnected(true);
        };

        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as T;
            // Call the LATEST onMessage via the ref (see above).
            onMessageRef.current(data);
          } catch {
            /* ignore parse errors — keep the stream healthy */
          }
        };

        es.onerror = () => {
          // Browser EventSource has its own auto-reconnect but it doesn't
          // do exponential backoff, so we close + retry manually.
          setConnected(false);
          try { es?.close(); } catch { /* noop */ }
          es = null;
          if (!stopped) {
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

    // --- Cleanup ---
    // TEACH: this cleanup runs when deps change (url/enabled) OR when the
    // owning component unmounts. Without this block, navigating away from
    // a page that mounted useSSE would leave the EventSource open forever,
    // and React StrictMode's double-mount would double-connect.
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
