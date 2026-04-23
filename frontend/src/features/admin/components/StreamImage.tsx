/**
 * StreamImage — renders a live per-source video tile by polling the
 * `/admin/frame/{id}` JPEG endpoint on POLL_INTERVAL_MS.streamImageFrame.
 *
 * At the pipeline's 2 fps inference rate, one poll cycle (~400ms) delivers
 * every new frame the edge produces — a push-based MJPEG transport would
 * add complexity for no perceptual gain. See CLAUDE.md "Live video
 * transport (admin grid)" for the rationale.
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: just the moving picture inside one video tile — the
 *   camera image itself, no buttons or labels around it.
 * Backend: GET /admin/frame/{id} (single-JPEG, polled).
 */
import { useEffect, useState } from "react";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import type { LiveSourceStatus } from "../../../shared/types/common";

// Append ?key=value or &key=value depending on whether the base URL
// already has a query string. Used here as a cache-buster for polled frames.
function appendQueryParam(baseUrl: string, key: string, value: string | number): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}${key}=${encodeURIComponent(String(value))}`;
}

interface StreamImageProps {
  source: LiveSourceStatus;
  className?: string;
  onError: () => void;
}

/**
 * StreamImage — polled per-source live tile.
 *
 * UI connections:
 *   - Parent: <StreamTile> (and, by extension, <MultiSourceGrid>) renders
 *     exactly one of these per camera tile.
 *   - CSS: none of its own — `className` is forwarded from StreamTile
 *     (styles.video) onto the underlying <img>.
 *
 * Backend endpoint:
 *   - GET /admin/frame/{id} — single JPEG, re-fetched every
 *     POLL_INTERVAL_MS.streamImageFrame.
 */
export function StreamImage({ source, className, onError }: StreamImageProps) {
  const baseUrl = `/admin/frame/${encodeURIComponent(source.id)}`;
  // `tick` is the cache-buster — each tick triggers a new GET. Seeded
  // lazily with `() => Date.now()` to avoid recomputing on every render.
  const [tick, setTick] = useState(() => Date.now());
  // `loaded` gates the "Connecting…" overlay: we don't want to flash it
  // on every subsequent poll, only the very first successful frame.
  const [loaded, setLoaded] = useState(false);

  // When the source swaps identity or restarts, reset `loaded` so the
  // overlay re-appears until the first new frame arrives.
  useEffect(() => {
    setLoaded(false);
  }, [source.id, source.started_at, baseUrl]);

  // Set up a polling interval on mount, tear it down on unmount.
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), POLL_INTERVAL_MS.streamImageFrame);
    return () => window.clearInterval(id);
  }, [source.id]);

  // Ignore errors until we've successfully loaded at least once — the
  // first poll can race the backend coming up, and we don't want that
  // transient failure to propagate to the parent tile as a hard error.
  const handleError = () => {
    if (loaded) onError();
  };

  const frameSrc = appendQueryParam(baseUrl, "t", tick);

  return (
    <>
      <img
        key={`${source.id}-${source.started_at ?? "x"}`}
        src={frameSrc}
        alt={`Live feed: ${source.name}`}
        className={className}
        style={loaded ? undefined : { visibility: "hidden" }}
        onLoad={() => {
          if (!loaded) setLoaded(true);
        }}
        onError={handleError}
      />
      {!loaded && (
        <div
          aria-live="polite"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#94a3b8",
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          Connecting&hellip;
        </div>
      )}
    </>
  );
}
