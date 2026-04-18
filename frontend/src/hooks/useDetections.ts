/**
 * useDetections — subscribes to `/admin/detections` SSE and exposes a
 * rolling window of recent detection frames plus live stats (counts + fps).
 *
 * Return shape:
 *   { frames, stats }
 *   - `frames` — up to MAX_FRAMES most recent DetectionSnapshots that
 *                actually contained objects (empty-object frames are still
 *                counted in stats but not pushed into the frame list).
 *   - `stats`  — { detections, persons, vehicles, interactions, fps } from
 *                the latest frame. `fps` is a string, recomputed over a
 *                3-second window.
 *
 * Consumers:
 *   - pages/AdminPage.tsx  (renders frames grid + stat cards)
 *
 * React concepts used: useState, useRef, useCallback, and the SSE wrapper
 * useSSE. See usePolling.ts and useSSE.ts for the first-teaching of each.
 */
import { useState, useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
import type { DetectionSnapshot } from "../types";

const MAX_FRAMES = 8;

export function useDetections() {
  // --- Local state ---
  const [frames, setFrames] = useState<DetectionSnapshot[]>([]);
  const [stats, setStats] = useState({
    detections: 0,
    persons: 0,
    vehicles: 0,
    interactions: 0,
    fps: "—",
  });

  // --- Ref-backed fps counter ---
  // TEACH: We track fps using a useRef because we want to MUTATE `count`
  // and `start` on every incoming frame without causing a render each
  // time. Only every ~3 seconds do we actually roll a new fps string into
  // state (which does render). Using useState for the counter would fire
  // a render per message — wasteful at 10+ Hz.
  const fpsCounterRef = useRef({ count: 0, start: Date.now() });

  const onMessage = useCallback((msg: DetectionSnapshot) => {
    const counter = fpsCounterRef.current;
    counter.count++;
    const now = Date.now();
    let fps = stats.fps;
    if (now - counter.start >= 3000) {
      fps = (counter.count / ((now - counter.start) / 1000)).toFixed(1);
      counter.count = 0;
      counter.start = now;
    }

    // Overwrite — stats are a snapshot of the latest frame, not cumulative.
    setStats({
      detections: msg.detections || 0,
      persons: msg.persons || 0,
      vehicles: msg.vehicles || 0,
      interactions: msg.interactions || 0,
      fps,
    });

    if (msg.objects?.length) {
      // Functional updater — newest-first, capped window. Same pattern as
      // useEventStream.ts.
      setFrames((prev) => {
        const next = [msg, ...prev];
        return next.length > MAX_FRAMES ? next.slice(0, MAX_FRAMES) : next;
      });
    }
    // NOTE: `stats.fps` is read above but intentionally NOT in deps — it
    // is only used to carry forward a placeholder between recomputes, and
    // including it would invalidate this callback every render. The stale
    // read is acceptable because it only gates a string initial value.
  }, []);

  // Opens the EventSource; closes it automatically on unmount via useSSE.
  useSSE<DetectionSnapshot>({
    url: "/admin/detections",
    onMessage,
  });

  return { frames, stats };
}
