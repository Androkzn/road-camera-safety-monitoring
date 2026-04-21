/**
 * AdminEventCard.tsx — compact event row used in the Admin sidebar.
 *
 * What it does:
 *   Renders a small card with a thumbnail on the left and on the right:
 *   a RiskBadge (compact), event type, wall time, a row of metadata tags
 *   (TTC, distance, track IDs, episode duration), and a one-line
 *   narration/summary if present.
 *
 * Purpose:
 *   Dense list row for the Admin page's Events and History tabs, optimized
 *   for scanning many events quickly.
 *
 * How it works:
 *   - Props: `event` is a `SafetyEvent` object (the backend's event model).
 *     Destructuring `{ event: e }` just renames `event` → `e` for brevity.
 *   - `normalizeThumbnail` is a helper that fixes up relative/data URLs.
 *   - Conditional rendering patterns like `e.ttc_sec != null && <Tag/>`
 *     mean "only render that Tag if ttc_sec is present" (`!= null` accepts
 *     anything except null or undefined).
 *   - The `<img onError>` fallback replaces the broken image with an em
 *     dash so the layout doesn't collapse.
 *
 * Connects to:
 *   - Backend: none directly — the `event` prop already contains server
 *     data from `/api/live/events` (history) or the SSE stream.
 *   - UI: rendered by `pages/AdminPage.tsx` (live Events tab) and
 *     `admin/HistoryPanel.tsx` (History tab).
 */
import type { SafetyEvent } from "../../types";
// Shared UI atoms: colored risk pill + generic rounded chip.
import { RiskBadge, Tag } from "../ui";
// Presentation helpers shared with the Dashboard card. See ../../lib/format.ts.
import { formatWallTime, humanEventType, normalizeThumbnail } from "../../lib/format";
// Locally-scoped CSS Module for this compact row style.
import styles from "./AdminEventCard.module.css";

// Props contract: takes one SafetyEvent (from the backend event model).
interface AdminEventCardProps {
  event: SafetyEvent;
}

// AdminEventCard — dense, one-line row variant used in the Admin Events tab
// and in the History panel. Consumer: pages/AdminPage.tsx + admin/HistoryPanel.
// Destructuring `{ event: e }` renames the prop to `e` locally.
export function AdminEventCard({ event: e }: AdminEventCardProps) {
  // Normalised thumbnail src (absolute URL or root-relative path).
  const thumb = normalizeThumbnail(e.thumbnail);
  // Pick whichever text field is available: narration > summary > empty string.
  // `||` returns the first truthy operand.
  const narr = e.narration || e.summary || "";

  return (
    // {/* Outer row container — horizontal layout (thumb | info block) */}
    <div className={styles.card}>
      {/* Small thumbnail on the left edge of the row */}
      <div className={styles.thumb}>
        {thumb ? (
          <img
            src={thumb}
            alt=""
            onError={(ev) => {
              // On load failure, replace the img with an em-dash so the row height stays stable.
              (ev.target as HTMLImageElement).parentElement!.textContent = "—";
            }}
          />
        ) : (
          "—"
        )}
      </div>
      {/* Right-hand info block: title line, metadata chips, one-line narration */}
      <div className={styles.info}>
        {/* Top title line: compact risk pill + event type + wall clock time */}
        <div className={styles.top}>
          <RiskBadge level={e.risk_level} compact />
          <span className={styles.type}>{humanEventType(e.event_type)}</span>
          <span className={styles.time}>{formatWallTime(e.wall_time)}</span>
        </div>
        {/* Chip row: TTC / distance / track IDs / episode duration */}
        <div className={styles.metaRow}>
          {/* TTC chip — highlighted orange when <= 1.5s (imminent risk) */}
          {e.ttc_sec != null && (
            <Tag variant={e.ttc_sec <= 1.5 ? "kin-warn" : "kin"}>
              TTC {Number(e.ttc_sec).toFixed(1)}s
            </Tag>
          )}
          {/* Metric distance chip */}
          {e.distance_m != null && (
            <Tag variant="kin">{Number(e.distance_m).toFixed(1)}m</Tag>
          )}
          {/* Pixel distance chip (fallback) */}
          {e.distance_px != null && <Tag>{Math.round(e.distance_px)}px</Tag>}
          {/* Track IDs chip like "#3/#7" */}
          {e.track_ids?.length ? <Tag>#{e.track_ids.join("/")}</Tag> : null}
          {/* Episode length chip like "ep 2.3s" */}
          {e.episode_duration_sec != null && (
            <Tag>ep {Number(e.episode_duration_sec).toFixed(1)}s</Tag>
          )}
        </div>
        {/* One-line narration/summary under the chips (truncated by CSS; hover shows full text) */}
        {narr && (
          <div className={styles.narr} title={narr}>
            {narr}
          </div>
        )}
      </div>
    </div>
  );
}
