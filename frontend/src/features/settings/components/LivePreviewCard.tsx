/**
 * LivePreviewCard — collapsed-by-default video preview on the right rail.
 * Defaults to the stream the operator focused on the Admin page; the
 * <select> lets them preview any active source.
 *
 * Lets the operator see the effect of a tunable change on a real stream
 * without tabbing back to Admin.
 *
 * NOTE: this reaches into `../../admin/components/StreamImage`, which
 * technically breaks the feature-isolation rule. If that matters in the
 * future, promote StreamImage to `shared/`.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: the live-preview card on the right column showing incoming
 *   video events under the proposed settings, with a source picker.
 * Backend:
 *   - GET /admin/frame/{id} (~400 ms JPEG polling) via <StreamImage>.
 *   This component itself does not hit /api/settings/* — it only consumes
 *   the `sources` list (derived from /api/live/status in the parent page).
 */

import { useEffect, useState } from "react";

import { StreamImage } from "../../admin/components/StreamImage";
import type { LiveSourceStatus } from "../../../shared/types/common";

import styles from "../SettingsPage.module.css";

/**
 * Props. `sources` is the full active-source list; `primaryId` is the
 * "focused" source from Admin (or null). `targetFps` is optional since
 * live status may not be loaded yet.
 */
interface LivePreviewCardProps {
  sources: LiveSourceStatus[];
  primaryId: string | null;
  fallbackSourceName: string;
  targetFps?: number;
}

/**
 * Render the collapsible preview. Keeps the picker hidden unless there
 * are ≥2 sources (no reason to offer a choice of one). Tracks the
 * operator's focus choice via a `localStorage` bridge so the Admin page
 * and the Settings page agree on "which stream are we looking at".
 */
export function LivePreviewCard({
  sources,
  primaryId,
  fallbackSourceName,
  targetFps,
}: LivePreviewCardProps) {
  // Lazy init from localStorage, with an SSR guard — Vite preview builds
  // never run server-side, but the guard costs nothing and makes the
  // snippet reusable.
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("road_admin_focused_id");
  });

  // Sync with the Admin page two ways:
  //   • "admin-focused-id-changed" — custom event, same-tab update.
  //   • "storage" — built-in cross-tab event when localStorage changes.
  // Returning a cleanup from useEffect unsubscribes on unmount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => {
      setPreviewSourceId(window.localStorage.getItem("road_admin_focused_id"));
    };
    window.addEventListener("admin-focused-id-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("admin-focused-id-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // Picker: operator-focused source first, then page-primary, then first
  // available, then null. Chained `??` makes each fallback explicit.
  const previewSource =
    sources.find((s) => s.id === previewSourceId) ??
    sources.find((s) => s.id === primaryId) ??
    sources[0] ??
    null;

  return (
    <details className={`${styles.card} ${styles.videoCard}`}>
      <summary className={styles.cardTitle}>Live preview</summary>
      {sources.length > 1 && (
        <select
          value={previewSource?.id ?? ""}
          onChange={(e) => setPreviewSourceId(e.target.value || null)}
          aria-label="Preview source"
          style={{ marginBottom: 8, width: "100%" }}
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.id === primaryId ? " (primary)" : ""}
            </option>
          ))}
        </select>
      )}
      {previewSource ? (
        <StreamImage
          source={previewSource}
          onError={() => {
            /* swallow — next poll / reconnect will recover */
          }}
        />
      ) : (
        <span className={styles.subtle}>No active source.</span>
      )}
      <span className={styles.subtle}>
        source: {previewSource?.name ?? fallbackSourceName}
        {targetFps ? ` @ ${targetFps}fps` : ""}
      </span>
    </details>
  );
}
