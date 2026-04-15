import { useState, useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
import type { SafetyEvent, PerceptionState } from "../types";

const MAX_EVENTS = 100;

export function useEventStream() {
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [perception, setPerception] = useState<PerceptionState | null>(null);
  const [connected, setConnected] = useState(false);
  const countsRef = useRef({ total: 0, high: 0, medium: 0 });

  const onMessage = useCallback((msg: SafetyEvent | PerceptionState) => {
    if ("_meta" in msg && msg._meta === "perception_state") {
      setPerception(msg as PerceptionState);
      return;
    }
    const ev = msg as SafetyEvent;
    countsRef.current.total++;
    if (ev.risk_level === "high") countsRef.current.high++;
    else if (ev.risk_level === "medium") countsRef.current.medium++;

    setEvents((prev) => {
      const next = [ev, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  const { isConnected } = useSSE<SafetyEvent | PerceptionState>({
    url: "/stream/events",
    onMessage: (data) => {
      setConnected(true);
      onMessage(data);
    },
  });

  return {
    events,
    perception,
    connected,
    isConnected,
    counts: countsRef.current,
  };
}
