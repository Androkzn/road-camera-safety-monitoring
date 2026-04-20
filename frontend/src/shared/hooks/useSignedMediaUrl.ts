/**
 * useSignedMediaUrl — mints BE-D13 signed URLs for `<img>` / EventSource endpoints
 * that cannot send `Authorization`. Refreshes before the 5-minute token expires.
 */
import { useEffect, useState } from "react";

import {
  adminFetch,
  getAdminToken,
  MissingAdminTokenError,
  subscribeToAdminTokenChanges,
} from "../lib/adminApi";

export interface SignedMediaState {
  signedUrl: string | null;
  error: string | null;
}

const REFRESH_BEFORE_EXPIRY_SEC = 90;

export function useSignedMediaUrl(
  sourceId: string,
  stream: "frame" | "mjpeg",
  enabled: boolean,
): SignedMediaState {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sourceId) {
      setSignedUrl(null);
      setError(null);
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };

    const mint = async () => {
      if (cancelled) return;
      clearTimer();
      try {
        if (!getAdminToken()) {
          setSignedUrl(null);
          setError("Paste admin token in Settings to load video");
          timeoutId = setTimeout(mint, 3000);
          return;
        }
        const q = new URLSearchParams({ source_id: sourceId, stream });
        const data = await adminFetch<{ url: string; expires_at: number }>(
          `/api/live/media_token?${q}`,
        );
        if (cancelled) return;
        setSignedUrl(data.url);
        setError(null);
        const nowSec = Math.floor(Date.now() / 1000);
        const delayMs = Math.max(15, data.expires_at - nowSec - REFRESH_BEFORE_EXPIRY_SEC) * 1000;
        timeoutId = setTimeout(mint, delayMs);
      } catch (e) {
        if (cancelled) return;
        setSignedUrl(null);
        if (e instanceof MissingAdminTokenError) {
          setError("Paste admin token in Settings to load video");
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
        timeoutId = setTimeout(mint, 10_000);
      }
    };

    void mint();
    const unsub = subscribeToAdminTokenChanges(() => {
      void mint();
    });

    return () => {
      cancelled = true;
      clearTimer();
      unsub();
    };
  }, [sourceId, stream, enabled]);

  return { signedUrl, error };
}

/** Append a cache-bust or remount query param to a URL that already has `?exp=&token=`. */
export function appendMediaQueryParam(
  baseUrl: string,
  key: string,
  value: string | number,
): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}${key}=${encodeURIComponent(String(value))}`;
}
