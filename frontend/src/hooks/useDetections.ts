/**
 * useDetections.ts — SSE hook for the live object-detection stream.
 *
 * What it does:
 *   Subscribes to /admin/detections (Server-Sent Events) and keeps a
 *   rolling window of up to 8 recent detection frames plus a live stats
 *   object (total detections, persons, vehicles, interactions, fps).
 *   Frames without any objects are dropped from the list but still update
 *   the stats.
 *
 * Purpose:
 *   Feeds the admin page's live video overlay and the "Detections" tab:
 *   shows the most recent frames with bounding boxes and real-time counts.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use`.
 *   - useState: holds the frames array and the stats object; changing
 *     either re-renders the consumer.
 *   - useRef: `fpsCounterRef` holds `{ count, start }` between messages
 *     without causing re-renders (useRef is for values that must persist
 *     across renders but shouldn't themselves trigger one).
 *   - useCallback: stabilizes the `onMessage` callback so the underlying
 *     EventSource isn't torn down on every render.
 *   - Every ~3 seconds the hook computes fps from how many messages
 *     arrived since the last reset, then updates the stats.
 *   - `setFrames(prev => [msg, ...prev])` uses the functional setState
 *     form to always reference the latest array, and caps length at
 *     MAX_FRAMES (8) by slicing.
 *   - useSSE<DetectionSnapshot>() handles the actual connection + parse +
 *     reconnect logic — see useSSE.ts. The <DetectionSnapshot> generic
 *     tells it how to type the parsed JSON.
 *
 * Connects to:
 *   - Backend: GET /admin/detections (Server-Sent Events) — defined in
 *     road_safety/server.py, emits DetectionSnapshot JSON frames.
 *   - UI: used by frontend/src/pages/AdminPage.tsx; `stats` feeds
 *     <VideoFeed/> and `frames` feeds <DetectionsPanel/>.
 */
// React imports: useState re-renders on change; useCallback memoizes a function; useRef is a mutable box without re-renders.
import { useState, useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
// `type`-only import: shape is erased at build time (zero runtime cost).
import type { DetectionSnapshot } from "../types";

// Keep only the 8 most recent frames so the UI stays snappy even after hours of streaming.
const MAX_FRAMES = 8;

// useDetections — subscribes to /admin/detections; returns { frames, stats } for overlays + counters.
// Consumed by: frontend/src/pages/AdminPage.tsx — `stats` feeds <VideoFeed/>, `frames` feeds <DetectionsPanel/>.
export function useDetections() {
  // Rolling list of detection frames (frames without objects are skipped so the panel doesn't flicker).
  const [frames, setFrames] = useState<DetectionSnapshot[]>([]);
  // Live counters + fps string (starts as an em-dash while we collect our first sample).
  const [stats, setStats] = useState({
    detections: 0,
    persons: 0,
    vehicles: 0,
    interactions: 0,
    fps: "—",
  });
  // useRef holds fps sampling state between messages without re-renders; resets every ~3s.
  const fpsCounterRef = useRef({ count: 0, start: Date.now() });

  // Stable callback (deps []) so useSSE never tears down the stream. Handles every parsed detection frame.
  const onMessage = useCallback((msg: DetectionSnapshot) => {
    const counter = fpsCounterRef.current;
    counter.count++;
    const now = Date.now();
    let fps = stats.fps;
    // Recompute fps once we have ~3s of samples; rounded to one decimal place.
    if (now - counter.start >= 3000) {
      fps = (counter.count / ((now - counter.start) / 1000)).toFixed(1);
      counter.count = 0;
      counter.start = now;
    }

    // `msg.detections || 0` falls back to 0 for missing/null numbers.
    setStats({
      detections: msg.detections || 0,
      persons: msg.persons || 0,
      vehicles: msg.vehicles || 0,
      interactions: msg.interactions || 0,
      fps,
    });

    // Optional chaining `?.` = only read .length if msg.objects is not null/undefined (avoids a TypeError).
    if (msg.objects?.length) {
      // Functional setState so bursts of frames don't clobber each other; slice caps length at MAX_FRAMES.
      setFrames((prev) => {
        const next = [msg, ...prev];
        return next.length > MAX_FRAMES ? next.slice(0, MAX_FRAMES) : next;
      });
    }
  }, []);

  // Delegate the SSE connect/parse/reconnect to useSSE. Backend: GET /admin/detections in road_safety/server.py.
  useSSE<DetectionSnapshot>({
    url: "/admin/detections",
    onMessage,
  });

  return { frames, stats };
}
