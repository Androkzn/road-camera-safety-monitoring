/**
 * useDetections — subscribes to `/admin/detections` SSE and exposes a
 * rolling window of recent detection frames plus aggregate stats + fps.
 *
 * Also tracks the latest authoritative MP4 playback position per source
 * (``playback_pos_sec``, ``playback_duration_sec``) and the wallclock
 * instant we received it. The map overlay reads this to drive its marker
 * directly off the video's actual playhead — so when the operator pauses
 * a stream, ``playback_pos_sec`` stops advancing and the marker freezes
 * with it. No 5 s polling drift.
 *
 * Why a custom hook? All the SSE plumbing + rolling-window bookkeeping
 * lives here so pages can just read `{ frames, stats, playheads }`.
 *
 * React/TS concepts first introduced in this file:
 *   - `useState` with a typed generic (`useState<Record<string, ...>>`).
 *   - `useRef` for mutable data that must NOT trigger re-renders (the
 *     fps counter — updating it 30× / sec should not re-render the tree).
 *   - `useCallback` to memoise the SSE message handler so `useSSE`
 *     doesn't re-subscribe on every render.
 *   - SSE (Server-Sent Events): one-way HTTP stream from server to
 *     browser. The `useSSE` shared hook opens the `EventSource` and
 *     invokes `onMessage` for each parsed JSON chunk.
 *   - TypeScript `Record<K, V>` — shorthand for `{ [key: K]: V }`.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: not visible on screen — this is the streaming data hook
 *   that feeds the "Detections" tab list, the per-frame counters in the
 *   header, and the playback-position marker on the map.
 * Backend: SSE /admin/detections.
 */
import { useState, useCallback, useRef } from "react";

import { LIMITS, POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { useSSE } from "../../../shared/hooks/useSSE";
import type { DetectionSnapshot } from "../../../shared/types/common";

/** Per-source playhead snapshot. */
export interface PlayheadSample {
  /** Authoritative MP4 position in seconds (``CAP_PROP_POS_MSEC / 1000``). */
  posSec: number;
  /** Total MP4 duration in seconds. */
  durationSec: number;
  /** Local wallclock (``performance.now()``) when this sample arrived.
   *  Used by the map hook to predict forward between SSE updates without
   *  drifting away from the server's authoritative clock. */
  receivedAtMs: number;
}

/**
 * Subscribe to the detections SSE feed. Returns:
 *   - `frames`:    newest-first list of snapshots that carried ≥1 object.
 *   - `stats`:     latest aggregate counters + computed fps.
 *   - `playheads`: map of source_id → latest MP4 playback sample.
 */
export function useDetections() {
  // TEACH: `useState<T>(initial)` declares a piece of component state.
  // The generic `<T>` tells TypeScript the type; `setFrames` is the
  // only way to change it (mutating the array directly does nothing).
  const [frames, setFrames] = useState<DetectionSnapshot[]>([]);
  const [stats, setStats] = useState({
    detections: 0,
    persons: 0,
    vehicles: 0,
    interactions: 0,
    fps: "—",
  });
  // Per-source latest playhead. We hold this in state (not a ref) so
  // consumers re-render when a new snapshot arrives. Each SSE message
  // overwrites only its own source key — slots stay independent.
  const [playheads, setPlayheads] = useState<Record<string, PlayheadSample>>({});

  // TEACH: `useRef` holds a *mutable* value across renders WITHOUT
  // triggering a re-render when it changes. Perfect for counters,
  // timers, DOM handles — anything that isn't part of the rendered UI.
  const fpsCounterRef = useRef({ count: 0, start: Date.now() });

  // TEACH: `useCallback` memoises a function identity so it's stable
  // across renders. `useSSE` uses this reference as a dependency; an
  // unstable callback would tear down + recreate the EventSource on
  // every render (expensive and would lose in-flight events).
  const onMessage = useCallback((msg: DetectionSnapshot) => {
    const counter = fpsCounterRef.current;
    counter.count++;
    const now = Date.now();
    setStats((prev) => {
      let fps = prev.fps;
      if (now - counter.start >= POLL_INTERVAL_MS.detectionsFpsWindow) {
        fps = (counter.count / ((now - counter.start) / 1000)).toFixed(1);
        counter.count = 0;
        counter.start = now;
      }
      return {
        detections: msg.detections || 0,
        persons: msg.persons || 0,
        vehicles: msg.vehicles || 0,
        interactions: msg.interactions || 0,
        fps,
      };
    });

    if (msg.objects?.length) {
      setFrames((prev) => {
        const next = [msg, ...prev];
        return next.length > LIMITS.detectionsFrames
          ? next.slice(0, LIMITS.detectionsFrames)
          : next;
      });
    }

    // Authoritative video playhead from the server. Recorded *every*
    // frame (even when ``objects`` is empty) so the map clock stays
    // fresh on quiet stretches of road too.
    if (msg.source_id && typeof msg.playback_pos_sec === "number") {
      const sample: PlayheadSample = {
        posSec: msg.playback_pos_sec,
        durationSec: msg.playback_duration_sec ?? 0,
        receivedAtMs: performance.now(),
      };
      setPlayheads((prev) => {
        const previous = prev[msg.source_id!];
        // Avoid useless re-renders when the server reports the exact
        // same value (paused stream → playhead frozen). We still
        // refresh ``receivedAtMs`` so consumers know the source is
        // alive, but only when the position actually moved or the
        // source was previously unknown.
        if (
          previous &&
          previous.posSec === sample.posSec &&
          previous.durationSec === sample.durationSec
        ) {
          return prev;
        }
        return { ...prev, [msg.source_id!]: sample };
      });
    }
  }, []);

  // TEACH: `useSSE<T>` opens an `EventSource` (browser SSE primitive)
  // against the given URL and calls `onMessage(parsed)` for each frame.
  // `<DetectionSnapshot>` is a generic — it types `msg` above.
  useSSE<DetectionSnapshot>({ url: "/admin/detections", onMessage });

  return { frames, stats, playheads };
}
