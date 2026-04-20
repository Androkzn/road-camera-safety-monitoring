/**
 * StreamTile — one live per-source tile in the admin grid.
 *
 * Extracted from `MultiSourceGrid` so the grid stays layout-only and
 * doesn't prop-drill start/pause/remove callbacks. Each tile mounts its
 * own `useStreamControl(source.id)` and `useStreamRegistry()` so React
 * Query tracks per-mutation `isPending` without the grid curating a busy
 * map.
 *
 * Focus/minimize state still flows top-down from `AdminPage` because the
 * page header also reads the focused id — making it a tile-local
 * decision would scatter that state across components.
 */
import { useEffect, useState } from "react";

import type { LiveSourceStatus } from "../../../shared/types/common";
import { useDialog } from "../../../shared/ui";

import { useStreamControl } from "../hooks/useStreamControl";
import { useStreamRegistry } from "../hooks/useStreamRegistry";

import styles from "./MultiSourceGrid.module.css";
import { StreamImage } from "./StreamImage";

export interface StreamTileProps {
  source: LiveSourceStatus;
  focused: boolean;
  minimized: boolean;
  onFocusToggle: () => void;
}

export function StreamTile({
  source,
  focused,
  minimized,
  onFocusToggle,
}: StreamTileProps) {
  const [imgError, setImgError] = useState(false);
  const dialog = useDialog();
  const { setDetection } = useStreamControl(source.id);
  const { remove } = useStreamRegistry();
  const running = source.running;

  // Reset the error flag when the source restarts or swaps identity, so a
  // tile that briefly failed gets a chance to reconnect on the next start.
  useEffect(() => {
    setImgError(false);
  }, [source.id, running]);

  // Auto-recover from transient image-load failures. A single failed JPEG
  // poll (e.g. server briefly overloaded by 6 streams sharing one YOLO model)
  // would otherwise flip ``imgError`` permanently, unmount <StreamImage>,
  // and stop polling — meaning the tile never recovers until the operator
  // restarts the source. Retrying after 1.5s lets the next poll succeed and
  // restores the live feed without operator action.
  useEffect(() => {
    if (!imgError || !running) return;
    const id = window.setTimeout(() => setImgError(false), 1500);
    return () => window.clearTimeout(id);
  }, [imgError, running]);

  const detection = source.detection_enabled;

  const tileClass = [
    styles.tile,
    !detection ? styles.tileMuted : "",
    focused ? styles.tileFocused : "",
    minimized ? styles.tileMini : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={tileClass}>
      <div
        className={styles.videoWrap}
        role="button"
        tabIndex={0}
        aria-label={
          focused
            ? `Restore grid view (currently maximized: ${source.name})`
            : `Maximize ${source.name}`
        }
        aria-pressed={focused}
        onClick={onFocusToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFocusToggle();
          }
        }}
      >
        {source.started_at && !imgError ? (
          // Keep the <StreamImage> mounted across pause/resume so the
          // last-delivered frame stays on screen (frozen) instead of
          // snapping to a placeholder. The server keeps the reader alive
          // while paused, so the MJPEG buffer still holds the last frame.
          <>
            <StreamImage
              source={source}
              className={styles.video}
              onError={() => setImgError(true)}
            />
            {!running && !source.last_error && (
              <span className={styles.pausedBadge}>Paused</span>
            )}
          </>
        ) : (
          <div className={styles.placeholder}>
            {source.last_error
              ? `Error: ${source.last_error}`
              : running
                ? "Connecting…"
                : "Paused"}
          </div>
        )}
        <span
          className={`${styles.statusDot} ${running ? styles.dotRunning : styles.dotPaused}`}
        />
        {!detection && running && (
          <span className={styles.detectionBadge}>detection off</span>
        )}
        {focused && (
          <span className={styles.focusedBadge} aria-hidden="true">
            Tap to restore
          </span>
        )}
        <button
          type="button"
          className={styles.removeBtn}
          title={`Remove ${source.name}`}
          aria-label={`Remove ${source.name}`}
          onClick={async (e) => {
            e.stopPropagation();
            const ok = await dialog.confirm({
              title: "Remove stream",
              message: `Remove "${source.name}" from monitoring? This stops its perception loop and frees the slot.`,
              okLabel: "Remove",
              cancelLabel: "Cancel",
              variant: "danger",
            });
            if (ok) void remove(source.id);
          }}
        >
          ×
        </button>
      </div>

      <div className={styles.meta}>
        <div className={styles.metaTop}>
          <strong className={styles.name}>{source.name}</strong>
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

      <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
        <label
          className={styles.detectionToggle}
          title="Toggle YOLO detection + event emission for this stream. Video preview keeps running either way."
        >
          <input
            type="checkbox"
            checked={detection}
            onChange={(e) => setDetection(e.target.checked)}
          />
          <span>Detection</span>
        </label>
      </div>
    </div>
  );
}
