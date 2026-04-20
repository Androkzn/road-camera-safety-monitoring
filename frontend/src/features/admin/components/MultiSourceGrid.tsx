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
import { useEffect, useState } from "react";

import type { UseLiveSourcesResult } from "../hooks/useLiveSources";
import type { LiveSourceStatus } from "../../../shared/types/common";
import { useDialog } from "../../../shared/ui";

import styles from "./MultiSourceGrid.module.css";
import { StreamImage } from "./StreamImage";

// Short label + tone for the per-tile mode badge. Kept here (not in a
// shared util) because it's only used by the grid right now — inline a
// helper rather than invent a module for three strings.
function modeBadge(streamType: LiveSourceStatus["stream_type"]):
  | { label: string; tone: "demo" | "live" }
  | null {
  switch (streamType) {
    case "dashcam_file":
      return { label: "Dash Cam · Demo", tone: "demo" };
    case "live_yt":
      return { label: "Live · YouTube", tone: "live" };
    case "live_hls":
      return { label: "Live · HLS", tone: "live" };
    case "webcam":
      return { label: "Webcam", tone: "live" };
    default:
      return null;
  }
}

function StreamTile({
  source,
  focused,
  minimized,
  onFocusToggle,
  onToggleDetection,
  onRemove,
}: {
  source: LiveSourceStatus;
  focused: boolean;
  minimized: boolean;
  onFocusToggle: () => void;
  onToggleDetection: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const dialog = useDialog();
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
        {running && !imgError ? (
          <StreamImage
            source={source}
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
        {(() => {
          const badge = modeBadge(source.stream_type);
          if (!badge) return null;
          const toneClass =
            badge.tone === "demo" ? styles.modeBadgeDemo : styles.modeBadgeLive;
          return (
            <span className={`${styles.modeBadge} ${toneClass}`}>
              {badge.label}
            </span>
          );
        })()}
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
            if (ok) onRemove();
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
            onChange={(e) => onToggleDetection(e.target.checked)}
          />
          <span>Detection</span>
        </label>
      </div>
    </div>
  );
}

function AddStreamForm({
  onAdd,
}: {
  onAdd: (input: { url: string; name?: string }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUrl("");
    setName("");
    setError(null);
  };

  const submit = async () => {
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await onAdd({ url: url.trim(), name: name.trim() || undefined });
      if (!res.ok) {
        // Backend created the slot but autostart failed — keep the form
        // open so the operator can correct the URL or just close.
        setError(res.error || "Failed to start stream");
      } else {
        reset();
        setOpen(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className={styles.addToggle}
        onClick={() => setOpen(true)}
      >
        + Add stream
      </button>
    );
  }

  return (
    <form
      className={styles.addForm}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        type="url"
        className={styles.addInput}
        placeholder="Paste a YouTube live URL or HLS .m3u8…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
        required
      />
      <input
        type="text"
        className={`${styles.addInput} ${styles.addInputName}`}
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="submit"
        className={`${styles.toolbarBtn} ${styles.addSubmit}`}
        disabled={!url.trim() || submitting}
      >
        {submitting ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        className={styles.toolbarBtn}
        onClick={() => {
          reset();
          setOpen(false);
        }}
        disabled={submitting}
      >
        Cancel
      </button>
      {error && <span className={styles.addError}>{error}</span>}
    </form>
  );
}

interface MultiSourceGridProps {
  // Controlled state lives in AdminPage so the page header can also read
  // the focused source. Pass the full hook result here and the grid
  // delegates start/pause/etc. straight to it.
  liveSources: UseLiveSourcesResult;
  focusedId: string | null;
  onFocusChange: (id: string | null) => void;
}

export function MultiSourceGrid({ liveSources, focusedId, onFocusChange }: MultiSourceGridProps) {
  const { sources, loading, error, start, pause, setDetection, add, remove, busyById } =
    liveSources;

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

  // Bulk-select counters work even when the list is empty (rendered below
  // the toolbar) — but the "Add stream" affordance must always be shown
  // so an operator who removed every tile can still recover.
  const enabledCount = sources.filter((s) => s.detection_enabled).length;
  const allEnabled = sources.length > 0 && enabledCount === sources.length;
  const noneEnabled = enabledCount === 0;
  const setAll = (enabled: boolean) => {
    sources.forEach((s) => {
      if (s.detection_enabled !== enabled) setDetection(s.id, enabled);
    });
  };

  // Shared "Start all" / "Pause all" controls. The per-tile start/pause
  // buttons still work for targeted control; these toolbar actions iterate
  // every source so the operator can bring the whole fleet online with one
  // click. The hook's optimistic update handles the running flag per-tile.
  const runningCount = sources.filter((s) => s.running).length;
  const allRunning = sources.length > 0 && runningCount === sources.length;
  const noneRunning = runningCount === 0;
  // Any start/pause mutation leaves a row in ``busyById`` until the server
  // confirms — while any row is in-flight we disable both bulk buttons to
  // avoid piling up requests on a slow backend.
  const anyBusy = Object.values(busyById).some((v) => v != null);
  const startAll = () => {
    sources.forEach((s) => {
      if (!s.running) start(s.id);
    });
  };
  const pauseAll = () => {
    sources.forEach((s) => {
      if (s.running) pause(s.id);
    });
  };

  const focusedSource = focusedId ? sources.find((s) => s.id === focusedId) ?? null : null;
  const minimizedSources = focusedSource ? sources.filter((s) => s.id !== focusedSource.id) : [];

  const renderTile = (s: LiveSourceStatus, opts: { focused: boolean; minimized: boolean }) => (
    <StreamTile
      key={s.id}
      source={s}
      focused={opts.focused}
      minimized={opts.minimized}
      onFocusToggle={() => onFocusChange(focusedId === s.id ? null : s.id)}
      onToggleDetection={(enabled) => setDetection(s.id, enabled)}
      onRemove={() => remove(s.id)}
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
          <AddStreamForm onAdd={add} />
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.toolbarBtnStart}`}
            onClick={startAll}
            disabled={allRunning || sources.length === 0 || anyBusy}
            title="Start every paused stream"
          >
            Start all
          </button>
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={pauseAll}
            disabled={noneRunning || anyBusy}
            title="Pause every running stream"
          >
            Pause all
          </button>
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => setAll(true)}
            disabled={allEnabled || sources.length === 0}
          >
            Select all
          </button>
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => setAll(false)}
            disabled={noneEnabled}
          >
            Clear all
          </button>
        </div>
      </div>
      {sources.length === 0 ? (
        <div className={styles.empty}>
          No streams yet. Click <strong>+ Add stream</strong> above to paste a URL,
          or set <code>ROAD_STREAM_SOURCES</code> in <code>.env</code> for permanent ones.
        </div>
      ) : focusedSource ? (
        <div className={styles.focusedLayout}>
          <div className={styles.focusedSlot}>
            {renderTile(focusedSource, { focused: true, minimized: false })}
          </div>
          {minimizedSources.length > 0 && (
            <div className={styles.miniStrip}>
              {minimizedSources.map((s) =>
                renderTile(s, { focused: false, minimized: true }),
              )}
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
