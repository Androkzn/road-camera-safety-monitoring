/**
 * useEventStream — subscribes to `/stream/events` (SSE) and exposes the
 * rolling list of the most recent SafetyEvents plus the latest
 * PerceptionState snapshot.
 *
 * TEACH: A "custom hook" is any `use*` function that may call other hooks.
 * This one composes useSSE underneath — a great example of how hooks chain:
 * lower-level hook handles the raw EventSource, higher-level hook adds
 * domain parsing and shape.
 *
 * Return shape (object):
 *   { events, perception, connected, counts }
 *   - `events`     — up to MAX_EVENTS most recent SafetyEvents, newest first.
 *   - `perception` — latest `_meta: "perception_state"` payload or null.
 *   - `connected`  — live-dot boolean from useSSE.
 *   - `counts`     — ref-backed { total, high, medium } tally (see warning).
 *
 * WARNING on `counts`: it's the live `.current` of a ref. Mutating a ref
 * does NOT trigger a re-render, so consumers that want a reactive counter
 * should derive it from `events` instead. The counter exists so that
 * components which DO re-render (because `events` changed) can read up-to-
 * date totals without forcing extra state updates per message.
 *
 * Consumers:
 *   - pages/DashboardPage.tsx    (uses events + connected + counts)
 *   - pages/AdminPage.tsx        (uses events + connected)
 *   - pages/MonitoringPage.tsx   (uses connected only)
 */
import { useState, useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
import type { SafetyEvent, PerceptionState } from "../types";

const MAX_EVENTS = 100;

export function useEventStream() {
  // --- Local state ---
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [perception, setPerception] = useState<PerceptionState | null>(null);

  // --- Non-reactive counters ---
  // TEACH: useRef gives a mutable box that survives renders but does NOT
  // cause a re-render when mutated. Perfect for "write often, read on next
  // natural render" counters where triggering a render per message would
  // be wasteful (this stream can fire 10+ times per second).
  const countsRef = useRef({ total: 0, high: 0, medium: 0 });

  // --- SSE message handler ---
  // TEACH: useCallback memoizes this function so its identity is stable.
  // We still re-read the latest handler inside useSSE via its own ref, but
  // stability here also protects any other consumer that might use it.
  const onMessage = useCallback((msg: SafetyEvent | PerceptionState) => {
    // The server multiplexes two payload kinds on one stream; we split by
    // the discriminator field `_meta`.
    if ("_meta" in msg && msg._meta === "perception_state") {
      setPerception(msg as PerceptionState);
      return;
    }
    const ev = msg as SafetyEvent;
    countsRef.current.total++;
    if (ev.risk_level === "high") countsRef.current.high++;
    else if (ev.risk_level === "medium") countsRef.current.medium++;

    // TEACH: Functional updater form `setX(prev => next)`. Prefer this
    // whenever the new state depends on the previous state, because `prev`
    // is guaranteed to be the latest committed value even if several
    // updates are queued back-to-back (common with high-frequency streams).
    setEvents((prev) => {
      const next = [ev, ...prev];
      // Cap the list length to avoid unbounded memory / re-render cost.
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  // Delegates the actual EventSource lifecycle to the generic hook.
  // See hooks/useSSE.ts.
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
