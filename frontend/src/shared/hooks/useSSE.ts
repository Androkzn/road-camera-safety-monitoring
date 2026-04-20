/**
 * useSSE — generic Server-Sent Events subscription hook.
 *
 * SSE doesn't fit into TanStack Query (it's a long-lived push channel,
 * not a pull). This hook owns the EventSource lifecycle: open on mount,
 * exponential-backoff reconnect on error, close on unmount.
 */
import { useEffect, useRef, useState } from "react";

import { SSE_BACKOFF } from "../config/runtime";

interface UseSSEOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  enabled?: boolean;
}

export function useSSE<T>({ url, onMessage, enabled = true }: UseSSEOptions<T>) {
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
