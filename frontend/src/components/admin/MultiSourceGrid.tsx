/**
 * MultiSourceGrid — renders one tile per configured perception source.
 *
 * Each tile shows the live MJPEG feed for its source, the name + URL,
 * a running/paused dot, frames-processed counter, and a Start / Pause
 * button. The button delegates to `useLiveSources()` mutators which
 * POST to `/api/live/sources/{id}/start|pause` and refresh the list.
 *
 * When only the primary source is configured (legacy single-stream
 * deployment) the grid still renders fine — it just shows one tile.
 */
import { useState } from "react";

import { useLiveSources } from "../../hooks/useLiveSources";
import type { LiveSourceStatus } from "../../types";

import styles from "./MultiSourceGrid.module.css";

function shortHost(url: string): string {
  if (!url) return "—";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 32);
  }
}

function StreamTile({
  source,
  busy,
  onStart,
  onPause,
}: {
  source: LiveSourceStatus;
  busy: boolean;
  onStart: () => void;
  onPause: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const running = source.running;

  return (
    <div className={styles.tile}>
      <div className={styles.videoWrap}>
        {running && !imgError ? (
          <img
            // Cache-busted on running-state transitions so the browser
            // re-establishes the MJPEG connection after a pause/resume
            // cycle (some browsers cache the closed multipart stream).
            key={`${source.id}-${source.started_at ?? "x"}`}
            src={`/admin/video_feed/${source.id}`}
            alt={`Live feed: ${source.name}`}
            className={styles.video}
            onError={() => setImgError(true)}
          />
        ) : (
          <div className={styles.placeholder}>
            {source.last_error
              ? `Error: ${source.last_error}`
              : running
                ? "Connecting…"
                : "Paused"}
          </div>
        )}
        <span className={`${styles.statusDot} ${running ? styles.dotRunning : styles.dotPaused}`} />
      </div>

      <div className={styles.meta}>
        <div className={styles.metaTop}>
          <strong className={styles.name}>{source.name}</strong>
          <span className={styles.host}>{shortHost(source.url)}</span>
        </div>
        <div className={styles.metaStats}>
          <span>{source.frames_processed.toLocaleString()} frames</span>
          <span>•</span>
          <span>{source.active_episodes} active</span>
          {source.perception_state && source.perception_state !== "nominal" && (
            <>
              <span>•</span>
              <span className={styles.warn}>{source.perception_state}</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        {running ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPause}`}
            onClick={onPause}
            disabled={busy}
          >
            {busy ? "Pausing…" : "Pause"}
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnStart}`}
            onClick={onStart}
            disabled={busy}
          >
            {busy ? "Starting…" : "Start"}
          </button>
        )}
      </div>
    </div>
  );
}

export function MultiSourceGrid() {
  const { sources, loading, error, start, pause, busyById } = useLiveSources(5000);

  if (loading && sources.length === 0) {
    return <div className={styles.empty}>Loading sources…</div>;
  }
  if (error && sources.length === 0) {
    return <div className={styles.empty}>Failed to load sources: {error}</div>;
  }
  if (sources.length === 0) {
    return (
      <div className={styles.empty}>
        No sources configured. Set <code>ROAD_STREAM_SOURCES</code> in <code>.env</code>.
      </div>
    );
  }

  return (
    <div className={styles.grid}>
      {sources.map((s) => (
        <StreamTile
          key={s.id}
          source={s}
          busy={!!busyById[s.id]}
          onStart={() => start(s.id)}
          onPause={() => pause(s.id)}
        />
      ))}
    </div>
  );
}
