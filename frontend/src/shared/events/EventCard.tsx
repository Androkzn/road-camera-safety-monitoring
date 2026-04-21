/**
 * EventCard — public-facing card for one SafetyEvent. Larger and richer
 * than AdminEventCard: shows enrichment row (vehicle color/type, plate
 * hash), and embeds FeedbackButtons so viewers can mark the detection
 * correct or wrong.
 *
 * --- UI mapping ---
 * Used on: DashboardPage, MonitoringPage (and any other shared event
 *   feed that needs the richer card; AdminPage uses its own slimmer
 *   variant).
 * UI element: rich event card row with thumbnail, risk badge, event
 *   type, time, TTC/distance tags, narration text, plate hash, and
 *   embedded Correct / False alarm feedback buttons.
 *
 * --- Backend endpoints (indirect) ---
 *  - The SafetyEvent it renders originates from `/api/events/stream`
 *    (SSE; see EventStreamProvider) or `/api/events/history` when pages
 *    backfill past events.
 *  - The embedded FeedbackButtons POSTs to `/api/events/{id}/feedback`.
 *  - Thumbnails referenced here are the `_public` redacted variant only
 *    (the internal full-frame variant never leaves the server). Plate
 *    text is stripped at ingest in enrich_event(); only `plate_hash`
 *    ever appears on the wire.
 */

import { useState, useEffect } from "react";

import { POLL_INTERVAL_MS, THRESHOLDS } from "../config/runtime";
import { cx } from "../lib/cx";
import {
  formatWallTime,
  humanEventType,
  formatConfidence,
  normalizeThumbnail,
} from "../lib/format";
import { RiskBadge, Tag } from "../ui";
import type { SafetyEvent } from "../types/common";

import { FeedbackButtons } from "./FeedbackButtons";
import styles from "./EventCard.module.css";

interface EventCardProps {
  event: SafetyEvent;
  isNew?: boolean;
  // When supplied, the card becomes a button that opens the parent's
  // event-detail dialog. Optional so callers that just want a static
  // card (reports, embed contexts) keep their existing behaviour.
  onSelect?: (event: SafetyEvent) => void;
}

/**
 * EventCard — interactive card for a SafetyEvent. When `onSelect` is
 * provided, the whole card becomes a button that opens the parent's
 * detail dialog; otherwise it's a static read-only card.
 *
 * Props:
 *  - event: the SafetyEvent payload (already privacy-scrubbed by the BE).
 *  - isNew: optional; if true, a brief highlight flash plays once on
 *    mount to draw the operator's eye to a fresh row.
 *  - onSelect: optional click handler; when present the card becomes an
 *    accessible button (role+tabIndex+Enter/Space) and typically opens
 *    an <EventDialog/> in the parent.
 *
 * UI connections:
 *  - Renders a <RiskBadge/> + <Tag/> primitives from shared/ui.
 *  - Embeds <FeedbackButtons/> whose clicks are stopPropagation'd so the
 *    card-level onSelect handler doesn't also fire.
 *
 * Backend calls (indirect): none directly. Thumbnails resolved via
 * normalizeThumbnail() always point at the `_public` variant; raw plate
 * text is never present on `event` (invariant enforced at ingest).
 */
export function EventCard({ event: e, isNew, onSelect }: EventCardProps) {
  // `isNew` triggers a brief highlight flash so operators spot fresh
  // rows in a scroll-heavy feed.
  const [flash, setFlash] = useState(isNew);

  useEffect(() => {
    if (!isNew) return;
    const t = setTimeout(() => setFlash(false), POLL_INTERVAL_MS.eventCardFlash);
    // Cleanup function — cancels the timer if the card unmounts or the
    // effect re-runs before the timeout fires.
    return () => clearTimeout(t);
  }, [isNew]);

  // `normalizeThumbnail` resolves the relative path from the event into a
  // loadable URL. The BE only ever emits the redacted `_public` variant on
  // shared channels — the internal full-frame thumb stays server-side.
  const thumb = normalizeThumbnail(e.thumbnail);
  const objs = e.objects?.length ? e.objects.join(" · ") : "—";
  const enr = e.enrichment;
  // The card is only interactive (button semantics) when a click handler
  // is actually wired up — prevents confusing keyboard focus rings on
  // static/embedded usages.
  const interactive = typeof onSelect === "function";

  // Friendly copy for per-event skip reasons. The backend only stamps
  // per-event reasons here (policy-level skipping is a deployment
  // property, not an event signal — see backend/perception/emit.py). The
  // legacy ``alpr_policy_disabled`` value is mapped to undefined so old
  // events in the rolling buffer don't surface a noisy banner.
  const skipLabel: Record<string, string> = {
    perception_degraded: "ALPR skipped — image quality too low",
    low_risk_event: "ALPR skipped — low-risk (batch review)",
  };
  const skipNote = e.enrichment_skipped ? skipLabel[e.enrichment_skipped] : undefined;

  return (
    <div
      className={cx(styles.card, flash && styles.flash, interactive && (styles.interactive ?? ""))}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onSelect?.(e) : undefined}
      onKeyDown={
        interactive
          ? (ke) => {
              if (ke.key === "Enter" || ke.key === " ") {
                ke.preventDefault();
                onSelect?.(e);
              }
            }
          : undefined
      }
      aria-label={interactive ? `Open details for ${humanEventType(e.event_type)}` : undefined}
    >
      <div className={styles.thumb}>
        {thumb ? (
          <img
            src={thumb}
            alt=""
            onError={(ev) => {
              (ev.target as HTMLImageElement).style.display = "none";
              (ev.target as HTMLImageElement).parentElement!.textContent = "no preview";
            }}
          />
        ) : (
          <span>no preview</span>
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.row1}>
          <RiskBadge level={e.risk_level} />
          <span className={styles.etype}>{humanEventType(e.event_type)}</span>
          <span className={styles.meta}>
            <span>{formatWallTime(e.wall_time)}</span>
            <span className={styles.sep}>•</span>
            <span>{e.timestamp_sec != null ? `T+${Number(e.timestamp_sec).toFixed(1)}s` : ""}</span>
          </span>
        </div>

        <div className={styles.meta}>
          <span>{objs}</span>
          <span className={styles.sep}>•</span>
          <span>conf {formatConfidence(e.confidence)}</span>
        </div>

        {(e.ttc_sec != null || e.distance_m != null || e.distance_px != null) && (
          <div className={styles.meta}>
            {e.ttc_sec != null && (
              <Tag
                variant={e.ttc_sec <= THRESHOLDS.ttcWarnSec ? "kin-warn" : "kin"}
                title="time-to-collision"
              >
                TTC {Number(e.ttc_sec).toFixed(1)}s
              </Tag>
            )}
            {e.distance_m != null && (
              <Tag variant="kin" title="distance">
                {Number(e.distance_m).toFixed(1)}m
              </Tag>
            )}
            {e.distance_px != null && <Tag>{Math.round(e.distance_px)}px</Tag>}
          </div>
        )}

        {e.narration ? (
          <div className={styles.narr}>{e.narration}</div>
        ) : e.summary ? (
          <div className={styles.summ}>{e.summary}</div>
        ) : null}

        {skipNote && <div className={styles.skipNote}>{skipNote}</div>}

        <div className={styles.row3}>
          {e.track_ids?.length ? <Tag variant="track">#{e.track_ids.join(" / #")}</Tag> : null}
          {e.episode_duration_sec != null && (
            <Tag>ep {Number(e.episode_duration_sec).toFixed(1)}s</Tag>
          )}
          {/* Privacy invariant: only the SALTED HASH ever reaches the
              frontend. Raw plate text is scrubbed in enrich_event(). */}
          {enr?.plate_hash && (
            <Tag variant="hash" title="salted plate hash">
              {enr.plate_hash}
            </Tag>
          )}
          {!enr?.plate_hash && enr?.readability && (
            <Tag variant="muted">plate {enr.readability}</Tag>
          )}
          {(enr?.vehicle_color || enr?.vehicle_type) && (
            <Tag>{[enr.vehicle_color, enr.vehicle_type].filter(Boolean).join(" ")}</Tag>
          )}
        </div>

        <div className={styles.row3}>
          <Tag>{e.event_id || ""}</Tag>
          <Tag>{e.video_id || ""}</Tag>
        </div>

        {/* stopPropagation keeps thumbs-up/down from bubbling into the
            card-level click handler that opens the event-detail dialog. */}
        <div onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
          <FeedbackButtons eventId={e.event_id} />
        </div>
      </div>
    </div>
  );
}
