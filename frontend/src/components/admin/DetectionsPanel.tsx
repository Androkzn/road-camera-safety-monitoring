import type { DetectionSnapshot } from "../../types";
import styles from "./DetectionsPanel.module.css";

interface DetectionsPanelProps {
  frames: DetectionSnapshot[];
}

export function DetectionsPanel({ frames }: DetectionsPanelProps) {
  if (frames.length === 0) {
    return <div className={styles.empty}>Waiting for detections&hellip;</div>;
  }

  return (
    <div className={styles.list}>
      {frames.map((frame, i) => {
        const ts = frame.ts ? new Date(frame.ts * 1000) : new Date();
        const tStr = isNaN(ts.getTime())
          ? "—"
          : `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;

        return (
          <div className={styles.frameGroup} key={`${frame.ts}-${i}`}>
            <div className={styles.frameHdr}>
              <span>{tStr}</span>
              <span>
                {frame.detections} det / {frame.interactions} int
              </span>
            </div>
            {frame.objects.map((o, j) => {
              const isPerson = o.cls === "person";
              const w = o.bbox[2] - o.bbox[0];
              const h = o.bbox[3] - o.bbox[1];

              return (
                <div className={styles.detRow} key={`${o.track_id ?? j}-${j}`}>
                  <span
                    className={`${styles.detCls} ${isPerson ? styles.person : styles.vehicle}`}
                  >
                    {o.cls}
                  </span>
                  <span className={styles.detConf}>
                    {(o.conf * 100).toFixed(0)}%
                  </span>
                  {o.track_id != null && (
                    <span className={styles.detTrack}>#{o.track_id}</span>
                  )}
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
