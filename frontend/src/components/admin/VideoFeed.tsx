/**
 * VideoFeed.tsx — the live annotated video tile on the Admin page.
 *
 * What it does:
 *   Renders the MJPEG stream from `/admin/video_feed` as an `<img>`, with
 *   a placeholder while loading and an error message if the stream is
 *   unavailable. Overlays five small stat cards (detections, persons,
 *   vehicles, interactions, fps) on top of the video.
 *
 * Purpose:
 *   Primary live view for the Admin page — it is the visual feedback loop
 *   showing what the pipeline sees right now, with numeric context.
 *
 * How it works:
 *   - Props: `stats` is a plain object with overlay numbers.
 *   - `useState` creates two boolean flags (`loaded`, `error`) that flip
 *     when the `<img>` element fires `onLoad` or `onError`. useState is
 *     the basic React hook for "a value that, when changed, re-renders
 *     the component so the UI updates".
 *   - Conditional rendering (`!loaded && !error && ...` and `error && ...`)
 *     swaps the placeholder text depending on stream state.
 *   - The browser keeps the MJPEG connection open automatically — there is
 *     no JS streaming logic here.
 *
 * Connects to:
 *   - Backend: the `<img src="/admin/video_feed">` hits the FastAPI
 *     multipart-JPEG endpoint in `road_safety/server.py`.
 *   - UI: rendered by `pages/AdminPage.tsx` as the left column of the
 *     two-column main layout, next to the sidebar `<TabBar>`.
 */
import { useState } from "react";
import styles from "./VideoFeed.module.css";

// Shape of the overlay stats object: five numbers shown over the top of the video.
interface VideoOverlayStats {
  detections: number;
  persons: number;
  vehicles: number;
  interactions: number;
  fps: string;
}

// Props for the VideoFeed component. `stats` drives the five overlay tiles.
interface VideoFeedProps {
  stats: VideoOverlayStats;
}

// Renders the big live video tile (left column of the Admin page main layout),
// with five small overlay stat cards sitting on top of the video.
export function VideoFeed({ stats }: VideoFeedProps) {
  // useState = React's "value that, when changed, re-renders the component".
  // `loaded` flips to true once the MJPEG image starts delivering frames.
  const [loaded, setLoaded] = useState(false);
  // `error` flips to true if the <img> fails (stream down / backend missing).
  const [error, setError] = useState(false);

  return (
    // Outer column wrapper — the left column of the Admin page layout
    <div className={styles.videoCol}>
      {/* Wrap div positions the overlay absolutely on top of the video */}
      <div className={styles.videoWrap}>
        {/* The actual live MJPEG image — browser keeps the connection open for us */}
        <img
          className={styles.feedImg}
          src="/admin/video_feed"
          alt="Live detection feed"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
        {/* "Waiting for video stream…" placeholder — only before first frame and no error */}
        {!loaded && !error && (
          <div className={styles.placeholder}>Waiting for video stream&hellip;</div>
        )}
        {/* "Video feed unavailable" placeholder — shown when the <img> fires onError */}
        {error && (
          <div className={styles.placeholder}>Video feed unavailable</div>
        )}
        {/* Overlay row — five small stat cards floating over the top of the video */}
        <div className={styles.overlay}>
          {/* Blue "detections" tile — total objects detected in current frame */}
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.accent}`}>{stats.detections}</div>
            <div className={styles.statLabel}>detections</div>
          </div>
          {/* Green "persons" tile — pedestrian count */}
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.green}`}>{stats.persons}</div>
            <div className={styles.statLabel}>persons</div>
          </div>
          {/* Amber "vehicles" tile — vehicle count */}
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.warn}`}>{stats.vehicles}</div>
            <div className={styles.statLabel}>vehicles</div>
          </div>
          {/* Red "interactions" tile — risky interactions between objects */}
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.danger}`}>{stats.interactions}</div>
            <div className={styles.statLabel}>interactions</div>
          </div>
          {/* Neutral "fps" tile — current throughput in frames per second */}
          <div className={styles.stat}>
            <div className={styles.num}>{stats.fps}</div>
            <div className={styles.statLabel}>fps</div>
          </div>
        </div>
      </div>
    </div>
  );
}
