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

import type {
  BusyAction,
  UseLiveSourcesResult,
} from "../../hooks/useLiveSources";
import type { LiveSourceStatus } from "../../types";
import { useDialog } from "../ui/Dialog";

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
  focused,
  minimized,
  onFocusToggle,
  onStart,
  onPause,
  onToggleDetection,
  onRemove,
}: {
  source: LiveSourceStatus;
  busy: boolean;
  focused: boolean;
  minimized: boolean;
  onFocusToggle: () => void;
  onStart: () => void;
  onPause: () => void;
  onToggleDetection: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const dialog = useDialog();
  const running = source.running;
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

  const focusedSource = focusedId ? sources.find((s) => s.id === focusedId) ?? null : null;
  const minimizedSources = focusedSource ? sources.filter((s) => s.id !== focusedSource.id) : [];

  const renderTile = (s: LiveSourceStatus, opts: { focused: boolean; minimized: boolean }) => (
    <StreamTile
      key={s.id}
      source={s}
      busy={!!busyById[s.id]}
      focused={opts.focused}
      minimized={opts.minimized}
      onFocusToggle={() => onFocusChange(focusedId === s.id ? null : s.id)}
      onStart={() => start(s.id)}
      onPause={() => pause(s.id)}
      onToggleDetection={(enabled) => setDetection(s.id, enabled)}
      onRemove={() => remove(s.id)}
    />
  );

  return (
    <div className={styles.gridWrap}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel}>
          Detection: <strong>{enabledCount}</strong> / {sources.length} streams
        </span>
        <div className={styles.toolbarActions}>
          <AddStreamForm onAdd={add} />
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
