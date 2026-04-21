/**
 * DetectionsPanel.tsx — live list of recent per-frame YOLO detections.
 *
 * What it does:
 *   Shows a scrollable list of frame snapshots. Each frame is a group with a
 *   timestamp header plus per-object rows (class name, confidence %, track
 *   id, and bbox width×height). Renders "Waiting for detections…" when the
 *   frame list is empty.
 *
 * Purpose:
 *   Developer/operator debug view into what the object detector is actually
 *   seeing in real time, frame by frame — used on the Admin page's sidebar.
 *
 * How it works:
 *   - Props: `frames` is an array of `DetectionSnapshot` objects pushed in
 *     from the parent's detection stream.
 *   - `frames.map((frame, i) => ...)` loops the list — one group per frame.
 *     The key uses `${frame.ts}-${i}` so React can track which DOM node
 *     corresponds to which item when the list changes (React needs a stable
 *     `key` on list items to update efficiently).
 *   - `new Date(frame.ts * 1000)` converts the backend's epoch-seconds float
 *     into a JavaScript Date (JS uses milliseconds).
 *   - Inner `.map()` renders each detected object row. Width/height come
 *     from subtracting bbox coordinates `[x1,y1,x2,y2]`.
 *
 * Connects to:
 *   - Backend: data comes from `useDetections` hook, which listens to the
 *     `/admin/detections` SSE stream.
 *   - UI: rendered by `pages/AdminPage.tsx` inside the "Detections" tab of
 *     the sidebar `<TabBar>`.
 */
import type { DetectionSnapshot } from "../../types";
import styles from "./DetectionsPanel.module.css";

// Props: the array of per-frame detection snapshots pushed in from the parent's SSE stream hook.
interface DetectionsPanelProps {
  frames: DetectionSnapshot[];
}

// Renders the scrollable per-frame detection list inside the "Detections" tab
// of the Admin page sidebar (right column of AdminPage).
export function DetectionsPanel({ frames }: DetectionsPanelProps) {
  // Empty state: shown before the first frame arrives over SSE
  if (frames.length === 0) {
    return <div className={styles.empty}>Waiting for detections&hellip;</div>;
  }

  return (
    // Scrollable vertical list of frame groups
    <div className={styles.list}>
      {/* Loops over each frame snapshot; `key` (built from timestamp + index) helps React track rows across re-renders */}
      {frames.map((frame, i) => {
        // Convert backend epoch-seconds float into a JS Date (JS uses ms, hence *1000).
        const ts = frame.ts ? new Date(frame.ts * 1000) : new Date();
        // Build an "HH:MM:SS" timestamp string. `?:` ternary picks em-dash when the date is invalid.
        const tStr = isNaN(ts.getTime())
          ? "—"
          : `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;

        return (
          // One frame group: header row + a list of detection rows
          <div className={styles.frameGroup} key={`${frame.ts}-${i}`}>
            {/* Frame header: left side timestamp, right side summary like "3 det / 1 int" */}
            <div className={styles.frameHdr}>
              <span>{tStr}</span>
              <span>
                {frame.detections} det / {frame.interactions} int
              </span>
            </div>
            {/* Inner loop: one row per detected object in this frame */}
            {frame.objects.map((o, j) => {
              // True when this detection is a pedestrian — drives the green pill color.
              const isPerson = o.cls === "person";
              // Bounding box width/height derived from [x1,y1,x2,y2] coordinates.
              const w = o.bbox[2] - o.bbox[0];
              const h = o.bbox[3] - o.bbox[1];

              return (
                // One detection row inside a frame group
                <div className={styles.detRow} key={`${o.track_id ?? j}-${j}`}>
                  {/* Class label pill (green for person, orange for vehicle) */}
                  <span
                    className={`${styles.detCls} ${isPerson ? styles.person : styles.vehicle}`}
                  >
                    {o.cls}
                  </span>
                  {/* Confidence as a whole-number percent, e.g. "87%" */}
                  <span className={styles.detConf}>
                    {(o.conf * 100).toFixed(0)}%
                  </span>
                  {/* Track id tag (e.g. "#42"); only shown when the tracker has assigned an id. `!= null` catches both null and undefined. */}
                  {o.track_id != null && (
                    <span className={styles.detTrack}>#{o.track_id}</span>
                  )}
                  {/* Bounding box size as "WIDTHxHEIGHT" */}
                  <span className={styles.detBbox}>
                    {w}×{h}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
