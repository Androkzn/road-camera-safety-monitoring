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
 * Backend: GET /api/live/sources for the list of tiles; bulk start/pause
 *   fans out POST /api/live/sources/{id}/start|pause.
 */
import { useEffect } from "react";

import type { LiveSourceStatus } from "../../../shared/types/common";

import { useLiveSourcesList } from "../hooks/useLiveSourcesList";
import { useStreamRegistry } from "../hooks/useStreamRegistry";

import styles from "./MultiSourceGrid.module.css";
import { StreamTile } from "./StreamTile";

interface MultiSourceGridProps {
  focusedId: string | null;
  onFocusChange: (id: string | null) => void;
}

export function MultiSourceGrid({ focusedId, onFocusChange }: MultiSourceGridProps) {
  const { sources, loading, error } = useLiveSourcesList();
  const { bulkSetRunning, bulkBusy } = useStreamRegistry();

  // Esc exits focus mode — common expectation for "maximized" UI.
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
