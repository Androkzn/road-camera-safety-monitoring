import { useEffect, useRef, useState } from "react";

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

    let backoff = 2000;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let es: EventSource | null = null;

    function connect() {
      if (stopped) return;
      try {
        es = new EventSource(url);

        es.onopen = () => {
          backoff = 2000;
          setConnected(true);
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
