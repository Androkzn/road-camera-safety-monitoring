/**
 * StreamImage — renders a live per-source video tile, choosing between
 * persistent MJPEG (`multipart/x-mixed-replace`) and short-poll JPEG
 * snapshots based on the deployment's likely HTTP version.
 *
 * POC: feeds use plain `/admin/video_feed/...` and `/admin/frame/...` URLs
 * (no signed query params or bearer headers).
 */
import { useEffect, useRef, useState } from "react";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";
import type { LiveSourceStatus } from "../../../shared/types/common";

type Transport = "mjpeg" | "poll";

const BLANK_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function appendQueryParam(baseUrl: string, key: string, value: string | number): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}${key}=${encodeURIComponent(String(value))}`;
}

function resolveTransport(): Transport {
  const override = (import.meta.env.VITE_ROAD_VIDEO_TRANSPORT ?? "")
    .toString()
    .trim()
    .toLowerCase();
  if (override === "mjpeg" || override === "poll") return override;
  if (typeof window === "undefined") return "poll";
  return window.location.protocol === "https:" ? "mjpeg" : "poll";
}

export const VIDEO_TRANSPORT: Transport = resolveTransport();

interface StreamImageProps {
  source: LiveSourceStatus;
  className?: string;
  onError: () => void;
}

export function StreamImage({ source, className, onError }: StreamImageProps) {
  if (VIDEO_TRANSPORT === "mjpeg") {
    return <MjpegStreamImage source={source} className={className} onError={onError} />;
  }
  return <PollingStreamImage source={source} className={className} onError={onError} />;
}

function MjpegStreamImage({ source, className, onError }: StreamImageProps) {
  const ref = useRef<HTMLImageElement>(null);
  const baseUrl = `/admin/video_feed/${encodeURIComponent(source.id)}`;
  const startedAt = source.started_at ?? 0;

  useEffect(() => {
    const img = ref.current;
    return () => {
      if (img) img.src = BLANK_GIF;
    };
  }, [source.id, startedAt, baseUrl]);

  const src = appendQueryParam(baseUrl, "v", startedAt);

  return (
    <img
      ref={ref}
      key={`${source.id}-${startedAt}`}
      src={src}
      alt={`Live feed: ${source.name}`}
      className={className}
      onError={onError}
    />
  );
}

function PollingStreamImage({ source, className, onError }: StreamImageProps) {
  const baseUrl = `/admin/frame/${encodeURIComponent(source.id)}`;
  const [tick, setTick] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [source.id, source.started_at, baseUrl]);

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), POLL_INTERVAL_MS.streamImageFrame);
    return () => window.clearInterval(id);
  }, [source.id]);

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
          Connecting…
        </div>
      )}
    </>
  );
}
