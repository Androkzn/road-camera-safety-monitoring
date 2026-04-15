import { useState } from "react";
import styles from "./VideoFeed.module.css";

interface VideoOverlayStats {
  detections: number;
  persons: number;
  vehicles: number;
  interactions: number;
  fps: string;
}

interface VideoFeedProps {
  stats: VideoOverlayStats;
}

export function VideoFeed({ stats }: VideoFeedProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className={styles.videoCol}>
      <div className={styles.videoWrap}>
        <img
          className={styles.feedImg}
          src="/admin/video_feed"
          alt="Live detection feed"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
        {!loaded && !error && (
          <div className={styles.placeholder}>Waiting for video stream&hellip;</div>
        )}
        {error && (
          <div className={styles.placeholder}>Video feed unavailable</div>
        )}
        <div className={styles.overlay}>
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.accent}`}>{stats.detections}</div>
            <div className={styles.statLabel}>detections</div>
          </div>
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.green}`}>{stats.persons}</div>
            <div className={styles.statLabel}>persons</div>
          </div>
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.warn}`}>{stats.vehicles}</div>
            <div className={styles.statLabel}>vehicles</div>
          </div>
          <div className={styles.stat}>
            <div className={`${styles.num} ${styles.danger}`}>{stats.interactions}</div>
            <div className={styles.statLabel}>interactions</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.num}>{stats.fps}</div>
            <div className={styles.statLabel}>fps</div>
          </div>
        </div>
      </div>
    </div>
  );
}
