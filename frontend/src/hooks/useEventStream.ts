/**
 * useEventStream.ts — SSE hook for the live safety-event stream.
 *
 * What it does:
 *   Subscribes to /stream/events (Server-Sent Events) and demultiplexes
 *   two kinds of messages that share the channel: SafetyEvent objects are
 *   prepended to a rolling list (max 100) while PerceptionState updates
 *   (messages with `_meta === "perception_state"`) replace a single
 *   perception slot. Also maintains running totals (total / high / medium).
 *   Returns `{ events, perception, connected, counts }`.
 *
 * Purpose:
 *   The dashboard page's main data source — drives the live event feed,
 *   summary tiles, perception banner, and the connected/offline pill.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use` that
 *     bundles state + effects.
 *   - useState holds the events list and the latest perception; these
 *     cause re-renders when they change.
 *   - useRef: `countsRef` holds the running totals without causing re-
 *     renders on every mutation — useRef is for values that persist across
 *     renders without themselves triggering one.
 *   - useCallback: stabilizes the `onMessage` function so useSSE doesn't
 *     tear down the connection on every render.
 *   - The runtime check `"_meta" in msg && msg._meta === "perception_state"`
 *     branches on the union type `SafetyEvent | PerceptionState` — the
 *     pipe means "either of these shapes" — and narrows it so TypeScript
 *     knows which fields are safe to read.
 *   - useSSE<SafetyEvent | PerceptionState> (see useSSE.ts) handles the
 *     actual connect/parse/reconnect cycle.
 *
 * Connects to:
 *   - Backend: GET /stream/events (Server-Sent Events) — defined in
 *     road_safety/server.py; emits SafetyEvent and PerceptionState JSON.
 *   - UI: used by frontend/src/pages/DashboardPage.tsx (main consumer),
 *     frontend/src/pages/AdminPage.tsx (for live events + connected pill),
 *     and frontend/src/pages/MonitoringPage.tsx (connected pill only).
 */
// React imports: useState re-renders on change; useCallback memoizes a function; useRef is a mutable box that doesn't re-render.
import { useState, useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
// `type` import: pulls only TypeScript shapes; erased at build time (zero runtime cost).
import type { SafetyEvent, PerceptionState } from "../types";

// Cap the rolling events list so we don't grow unbounded in memory as the stream runs for hours.
const MAX_EVENTS = 100;

// useEventStream — subscribes to /stream/events; returns { events, perception, connected, counts }.
// Consumed by: frontend/src/pages/DashboardPage.tsx (main feed, tiles, perception banner),
// frontend/src/pages/AdminPage.tsx (live events + connected pill), frontend/src/pages/MonitoringPage.tsx (pill only).
export function useEventStream() {
  // Rolling list of safety events, newest first; re-renders consumers when a new event arrives.
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  // Single slot for the latest perception snapshot (fog, glare, etc.); null until first perception msg.
  const [perception, setPerception] = useState<PerceptionState | null>(null);
  // Running totals kept in a ref so incrementing them doesn't cause re-renders — read directly in the returned object.
  const countsRef = useRef({ total: 0, high: 0, medium: 0 });

  // useCallback with [] means this function is created once and never changes; keeps useSSE from tearing down the stream.
  // Union type `SafetyEvent | PerceptionState` means the param is one of those two shapes; the `"_meta" in msg` check narrows it.
  const onMessage = useCallback((msg: SafetyEvent | PerceptionState) => {
    if ("_meta" in msg && msg._meta === "perception_state") {
      setPerception(msg as PerceptionState);
      return;
    }
    const ev = msg as SafetyEvent;
    countsRef.current.total++;
    if (ev.risk_level === "high") countsRef.current.high++;
    else if (ev.risk_level === "medium") countsRef.current.medium++;

    // Functional setState: React passes the current array so rapid-fire events don't clobber each other.
    // Spread [ev, ...prev] = new array with ev first; slice caps length at MAX_EVENTS.
    setEvents((prev) => {
      const next = [ev, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  // Delegate the actual SSE connection + reconnect to useSSE; it calls onMessage for each parsed JSON message.
  // Backend endpoint: GET /stream/events in road_safety/server.py.
  const { connected } = useSSE<SafetyEvent | PerceptionState>({
    url: "/stream/events",
    onMessage,
  });

  return {
    events,
    perception,
    connected,
    counts: countsRef.current,
  };
}
