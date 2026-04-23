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
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: a single live video tile inside the admin grid — shows the
 *   moving picture for one camera plus the small per-tile controls
 *   (toggle detection, focus/maximize, remove).
 * Backend:
 *   - Video: GET /admin/frame/{id} (polled JPEG) via <StreamImage>.
 *   - Controls: per-source mutations against the /api/streams registry,
 *     issued by `useStreamControl(source.id).setDetection` (detection
 *     toggle) and `useStreamRegistry().remove` (DELETE /api/streams/{id}).
 */
import { useEffect, useState } from "react";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import { cx } from "../../../shared/lib/cx";
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

/**
 * StreamTile — one live camera tile inside the admin grid.
 *
 * UI connections:
 *   - Parent: <MultiSourceGrid> renders one StreamTile per LiveSourceStatus
 *     (in either the focused layout's big slot, its minimized strip, or
 *     the default grid layout).
 *   - Child elements: <StreamImage> (the moving picture), inline badges
 *     (statusDot, pausedBadge, warmingBadge, detectionBadge, focusedBadge),
 *     a remove <button> with a shared <useDialog> confirmation, metadata
 *     row, and a Detection <input type="checkbox"> toggle.
 *   - CSS: MultiSourceGrid.module.css (shared across grid + tile) —
 *     `.tile`, `.tileMuted`, `.tileFocused`, `.tileMini`, `.videoWrap`,
 *     `.video`, `.placeholder`, `.statusDot`, `.dotRunning`, `.dotPaused`,
 *     `.pausedBadge`, `.warmingBadge`, `.detectionBadge`, `.focusedBadge`,
 *     `.removeBtn`, `.meta`, `.metaTop`, `.name`, `.metaStats`, `.warn`,
 *     `.actions`, `.detectionToggle`.
 *
 * Backend endpoints:
 *   - GET /admin/frame/{id} via <StreamImage>.
 *   - Detection toggle: `useStreamControl(source.id).setDetection` POSTs
 *     to the /api/streams registry to flip YOLO on/off for this source.
 *   - Remove: `useStreamRegistry().remove` DELETEs the source from the
 *     /api/streams registry (stops its perception loop and frees the slot).
 */
export function StreamTile({ source, focused, minimized, onFocusToggle }: StreamTileProps) {
  // Local view state only: whether the <StreamImage> has hard-failed.
  // Mutation state (pending/error for start/pause/detection/remove) lives
  // in TanStack Query inside the two hooks below, not here.
  const [imgError, setImgError] = useState(false);
  const dialog = useDialog();
  // Per-tile hook instance — `setDetection` POSTs to /api/streams to flip
  // YOLO detection on/off for this specific source id.
  const { setDetection } = useStreamControl(source.id);
  // Shared registry hook — `remove` issues DELETE /api/streams/{id}.
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
    const id = window.setTimeout(() => setImgError(false), POLL_INTERVAL_MS.streamTileRetry);
    return () => window.clearTimeout(id);
  }, [imgError, running]);

  const detection = source.detection_enabled;

  const tileClass = cx(
    styles.tile,
    !detection && styles.tileMuted,
    focused && styles.tileFocused,
    minimized && styles.tileMini,
  );

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
          // while paused, so the slot still holds the last frame.
          <>
            <StreamImage
              source={source}
              className={styles.video}
              onError={() => setImgError(true)}
            />
            {running && source.frames_processed === 0 && (
              <span className={styles.warmingBadge}>Warming up…</span>
            )}
            {!running && !source.last_error && <span className={styles.pausedBadge}>Paused</span>}
          </>
        ) : (
          <div className={styles.placeholder}>
            {source.last_error ? `Error: ${source.last_error}` : running ? "Connecting…" : "Paused"}
          </div>
        )}
        <span className={`${styles.statusDot} ${running ? styles.dotRunning : styles.dotPaused}`} />
        {!detection && running && <span className={styles.detectionBadge}>detection off</span>}
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
