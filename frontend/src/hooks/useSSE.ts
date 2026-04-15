import { useEffect, useRef, useCallback } from "react";

interface UseSSEOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  enabled?: boolean;
}

export function useSSE<T>({ url, onMessage, enabled = true }: UseSSEOptions<T>) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let backoff = 2000;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    function connect() {
      if (stopped) return;
      try {
        const es = new EventSource(url);
        esRef.current = es;

        es.onopen = () => {
          backoff = 2000;
        };

        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as T;
            onMessageRef.current(data);
          } catch {
            /* ignore parse errors */
          }
        };

        es.onerror = () => {
          try { es.close(); } catch { /* noop */ }
          esRef.current = null;
          if (!stopped) {
            timer = setTimeout(connect, backoff);
            backoff = Math.min(backoff * 1.5, 30000);
          }
        };
      } catch {
        if (!stopped) {
          timer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 1.5, 30000);
        }
      }
    }

    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      try { esRef.current?.close(); } catch { /* noop */ }
      esRef.current = null;
    };
  }, [url, enabled]);

  const isConnected = useCallback(() => {
    return esRef.current?.readyState === EventSource.OPEN;
  }, []);

  return { isConnected };
}
