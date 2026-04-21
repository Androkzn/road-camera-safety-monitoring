/**
 * MultiSourceGrid — layout container for one tile per perception source.
 *
 * Renders the bulk toolbar (start-all / pause-all) plus the
 * focused-source layout. Each tile is a `StreamTile` that owns its
 * own mutations via `useStreamControl` — the grid does not prop-drill
 * per-source callbacks anymore.
 *
 * When only the primary source is configured (legacy single-stream
 * deployment) the grid still renders fine — it just shows one tile.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: the grid of live video tiles in the middle of the page,
 *   with a small toolbar above it for "start all" / "pause all". When
 *   one tile is focused, the grid switches to a maximized layout for
 *   that tile.
 * Backend: registry reads + writes go through GET/POST /api/streams
 *   (the `useLiveSourcesList` + `useStreamRegistry` hooks). Per-tile
 *   start/pause/detection/remove are issued by each <StreamTile>; this
 *   grid only orchestrates the bulk start-all / pause-all fan-out via
 *   `useStreamRegistry().bulkSetRunning`.
 */
import { useEffect } from "react";

import type { LiveSourceStatus } from "../../../shared/types/common";

import { useLiveSourcesList } from "../hooks/useLiveSourcesList";
import { useStreamRegistry } from "../hooks/useStreamRegistry";

import styles from "./MultiSourceGrid.module.css";
import { StreamTile } from "./StreamTile";

// TEACH: Focus state is *lifted* to AdminPage (hence props, not local
// useState) because the SelectedStreamHeader above the grid also needs
// to read it. Child tiles request a toggle via `onFocusChange`.
interface MultiSourceGridProps {
  focusedId: string | null;
  onFocusChange: (id: string | null) => void;
}

/**
 * MultiSourceGrid — layout container for the admin multi-camera grid.
 *
 * UI connections:
 *   - Parent: AdminPage passes `focusedId` + `onFocusChange` so the page
 *     header can stay in sync with the grid's maximized tile.
 *   - Child elements: a toolbar with start-all / pause-all <button>s and
 *     a running-count label; zero or more <StreamTile> children laid out
 *     as either a grid (no focus) or a focused-slot + minimized strip.
 *   - CSS: MultiSourceGrid.module.css — `.gridWrap`, `.toolbar`,
 *     `.toolbarLabel`, `.toolbarActions`, `.toolbarBtn`,
 *     `.toolbarBtnStart`, `.empty`, `.focusedLayout`, `.focusedSlot`,
 *     `.miniStrip`, `.grid`.
 *
 * Backend endpoints:
 *   - Source list and per-source status come from `useLiveSourcesList`,
 *     which polls GET /api/streams.
 *   - Bulk start/pause calls in the toolbar go through
 *     `useStreamRegistry().bulkSetRunning`, which fans out per-source
 *     POSTs against the /api/streams registry.
 *   - No video URLs are opened here — tiles own their own /admin/frame
 *     connections.
 */
export function MultiSourceGrid({ focusedId, onFocusChange }: MultiSourceGridProps) {
  // `sources` is polled from GET /api/streams via TanStack Query under the
  // hood (see hooks/useLiveSourcesList). `bulkSetRunning` fans one-click
  // toolbar actions out to per-source mutations; `bulkBusy` lets us disable
  // the buttons while any of those mutations is still pending.
  const { sources, loading, error } = useLiveSourcesList();
  const { bulkSetRunning, bulkBusy } = useStreamRegistry();

  // Esc exits focus mode — common expectation for "maximized" UI.
  // useEffect side effect: subscribes a global `keydown` listener while
  // focus mode is active, and returns a cleanup that removes it. Guarded
  // by an early `return` when nothing is focused so we never attach a
  // listener unnecessarily. Re-runs when `focusedId` or the callback
  // identity changes.
  useEffect(() => {
    if (!focusedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFocusChange(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedId, onFocusChange]);

  if (loading && sources.length === 0) {
    return <div className={styles.empty}>Loading sources…</div>;
  }
  if (error && sources.length === 0) {
    return <div className={styles.empty}>Failed to load sources: {error}</div>;
  }

  const enabledCount = sources.filter((s) => s.detection_enabled).length;
  const runningCount = sources.filter((s) => s.running).length;
  const allRunning = sources.length > 0 && runningCount === sources.length;
  const noneRunning = runningCount === 0;

  const startAll = () =>
    bulkSetRunning(
      "start",
      sources.filter((s) => !s.running).map((s) => s.id),
    );
  const pauseAll = () =>
    bulkSetRunning(
      "pause",
      sources.filter((s) => s.running).map((s) => s.id),
    );

  // Resolve the id-based focus selection to an actual source object so the
  // render code below can branch on "do we have a focused tile?". If the
  // focused id no longer exists (e.g. the stream was removed elsewhere),
  // treat it as "no focus" — the grid view returns.
  const focusedSource = focusedId ? (sources.find((s) => s.id === focusedId) ?? null) : null;
  const minimizedSources = focusedSource ? sources.filter((s) => s.id !== focusedSource.id) : [];

  const renderTile = (s: LiveSourceStatus, opts: { focused: boolean; minimized: boolean }) => (
    <StreamTile
      key={s.id}
      source={s}
      focused={opts.focused}
      minimized={opts.minimized}
      onFocusToggle={() => onFocusChange(focusedId === s.id ? null : s.id)}
    />
  );

  return (
    <div className={styles.gridWrap}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel}>
          Running: <strong>{runningCount}</strong> / {sources.length}
          {sources.length > 0 && (
            <>
              {" · "}
              Detection: <strong>{enabledCount}</strong> / {sources.length}
            </>
          )}
        </span>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.toolbarBtnStart}`}
            onClick={startAll}
            disabled={allRunning || sources.length === 0 || bulkBusy}
            title="Start every paused stream"
          >
            Start
          </button>
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={pauseAll}
            disabled={noneRunning || bulkBusy}
            title="Pause every running stream"
          >
            Pause
          </button>
        </div>
      </div>
      {sources.length === 0 ? (
        <div className={styles.empty}>
          No streams yet. Set <code>ROAD_STREAM_SOURCES</code> in <code>.env</code> and restart the
          server.
        </div>
      ) : focusedSource ? (
        <div className={styles.focusedLayout}>
          <div className={styles.focusedSlot}>
            {renderTile(focusedSource, { focused: true, minimized: false })}
          </div>
          {minimizedSources.length > 0 && (
            <div className={styles.miniStrip}>
              {minimizedSources.map((s) => renderTile(s, { focused: false, minimized: true }))}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {sources.map((s) => renderTile(s, { focused: false, minimized: false }))}
        </div>
      )}
    </div>
  );
}
