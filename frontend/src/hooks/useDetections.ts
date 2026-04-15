import { useState, useCallback, useRef } from "react";
import { useSSE } from "./useSSE";
import type { DetectionSnapshot } from "../types";

const MAX_FRAMES = 8;

export function useDetections() {
  const [frames, setFrames] = useState<DetectionSnapshot[]>([]);
  const [stats, setStats] = useState({
    detections: 0,
    persons: 0,
    vehicles: 0,
    interactions: 0,
    fps: "—",
  });
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

    setStats({
      detections: msg.detections || 0,
      persons: msg.persons || 0,
      vehicles: msg.vehicles || 0,
      interactions: msg.interactions || 0,
      fps,
    });

    if (msg.objects?.length) {
      setFrames((prev) => {
        const next = [msg, ...prev];
        return next.length > MAX_FRAMES ? next.slice(0, MAX_FRAMES) : next;
      });
    }
  }, []);

  useSSE<DetectionSnapshot>({
    url: "/admin/detections",
    onMessage,
  });

  return { frames, stats };
}
