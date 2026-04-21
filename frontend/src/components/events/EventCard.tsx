/**
 * EventCard.tsx — full-size event card for the Dashboard stream.
 *
 * What it does:
 *   Renders a safety event with a thumbnail, risk badge, type, wall time,
 *   T+timestamp, detected objects, confidence, kinematics (TTC / distance),
 *   a narration/summary paragraph, an optional "enrichment skipped" note,
 *   tracker/episode/plate/vehicle tags, event/video IDs, and the
 *   FeedbackButtons row at the bottom. When `isNew` is true, the card
 *   briefly highlights via a flash animation.
 *
 * Purpose:
 *   The primary operator-facing representation of a safety event in the
 *   main live Dashboard stream.
 *
 * How it works:
 *   - Props: `event` (SafetyEvent from the backend), optional `isNew` to
 *     trigger the flash-highlight.
 *   - `useState(isNew)` stores a `flash` flag. `useEffect(..., [isNew])`
 *     runs after render: if `isNew`, it sets a 1500ms timer to turn flash
 *     off, and returns a cleanup function that clears the timer if the
 *     component unmounts or `isNew` changes first.
 *   - Conditional rendering via short-circuit (`cond && <X/>`) and
 *     ternaries (`a ? <A/> : b ? <B/> : null`) picks which sections render
 *     based on which data fields are present.
 *   - `e.objects.join(" · ")` turns an array into a string separated by
 *     middle dots.
 *
 * Connects to:
 *   - Backend: the `event` prop originates from `useEventStream`
 *     (SSE `/api/live/events/stream`). `FeedbackButtons` inside this card
 *     also POSTs to `/api/feedback`.
 *   - UI: rendered by `pages/DashboardPage.tsx` in the live event stream
 *     column, alongside `<CopilotPanel>`.
 */
// React hooks: useState holds re-render-triggering values; useEffect runs side
// effects (timers, subscriptions) after render.
import { useState, useEffect } from "react";
import type { SafetyEvent } from "../../types";
// RiskBadge = colored pill (low/medium/high/critical). Tag = small rounded chip.
import { RiskBadge, Tag } from "../ui";
// Feedback row (thumbs up / down) rendered at the bottom of the card.
import { FeedbackButtons } from "./FeedbackButtons";
// Pure string helpers from ../../lib/format — see that file for details.
import {
  formatWallTime,
  humanEventType,
  formatConfidence,
  normalizeThumbnail,
} from "../../lib/format";
// CSS Modules: `styles.card` is a locally-scoped class name (avoids collisions).
import styles from "./EventCard.module.css";

// Props contract for this component. `?` on isNew means the caller can omit it.
interface EventCardProps {
  event: SafetyEvent;
  isNew?: boolean;
}

// EventCard — the big event card shown in the Dashboard's live event column.
// Consumer: pages/DashboardPage.tsx renders one per SSE event.
// `{ event: e }` is destructuring that renames `event` to `e` for brevity.
export function EventCard({ event: e, isNew }: EventCardProps) {
  // `flash` — true while the new-event highlight animation should play.
  // Changes from true to false after the 1.5s timer below fires.
  const [flash, setFlash] = useState(isNew);

  // useEffect(fn, deps): runs `fn` after render whenever items in `deps` change.
  // Here: start a 1.5s timer that clears the flash highlight. The returned
  // function is a cleanup — React calls it if isNew changes or on unmount
  // so we never leave stray timers running.
  useEffect(() => {
    if (!isNew) return;
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [isNew]);

  // Fix up thumbnail URL (absolute vs relative). See format.ts.
  const thumb = normalizeThumbnail(e.thumbnail);
  // Optional chaining `?.` short-circuits to undefined if e.objects is missing.
  // Template string (backticks) would allow `${}`; here we use a plain join.
  const objs = e.objects?.length ? e.objects.join(" · ") : "—";
  const enr = e.enrichment;

  return (
    // {/* Outer card container — gets the `flash` class briefly on new events */}
    <div className={`${styles.card} ${flash ? styles.flash : ""}`}>
      {/* Thumbnail image shown on the left side of the card */}
      <div className={styles.thumb}>
        {thumb ? (
          <img
            src={thumb}
            alt=""
            onError={(ev) => {
              // If the image fails to load, hide it and replace with "no preview".
              (ev.target as HTMLImageElement).style.display = "none";
              (ev.target as HTMLImageElement).parentElement!.textContent = "no preview";
            }}
          />
        ) : (
          // Fallback placeholder when no thumbnail URL is available.
          <span>no preview</span>
        )}
      </div>
      {/* Right-hand body: all the textual detail rows */}
      <div className={styles.body}>
        {/* Title row: risk badge + event type + wall time + T+seconds */}
        <div className={styles.row1}>
          <RiskBadge level={e.risk_level} />
          <span className={styles.etype}>{humanEventType(e.event_type)}</span>
          <span className={styles.meta}>
            <span>{formatWallTime(e.wall_time)}</span>
            <span className={styles.sep}>•</span>
            <span>
              {e.timestamp_sec != null ? `T+${Number(e.timestamp_sec).toFixed(1)}s` : ""}
            </span>
          </span>
        </div>

        {/* Second meta line: detected objects list and confidence percentage */}
        <div className={styles.meta}>
          <span>{objs}</span>
          <span className={styles.sep}>•</span>
          <span>conf {formatConfidence(e.confidence)}</span>
        </div>

        {/* Kinematics row: only shown if TTC / distance / pixel distance exist.
            `cond && <X/>` means "render X only when cond is truthy". */}
        {(e.ttc_sec != null || e.distance_m != null || e.distance_px != null) && (
          <div className={styles.meta}>
            {/* Time-to-collision chip — turns orange when TTC <= 1.5s */}
            {e.ttc_sec != null && (
              <Tag variant={e.ttc_sec <= 1.5 ? "kin-warn" : "kin"} title="time-to-collision">
                TTC {Number(e.ttc_sec).toFixed(1)}s
              </Tag>
            )}
            {/* Distance-in-metres chip */}
            {e.distance_m != null && (
              <Tag variant="kin" title="distance">
                {Number(e.distance_m).toFixed(1)}m
              </Tag>
            )}
            {/* Pixel-distance chip (fallback when metric distance isn't known) */}
            {e.distance_px != null && <Tag>{Math.round(e.distance_px)}px</Tag>}
          </div>
        )}

        {/* Narration paragraph, or summary paragraph, or nothing. Ternary
            `a ? X : b ? Y : null` picks the first available text field. */}
        {e.narration ? (
          <div className={styles.narr}>{e.narration}</div>
        ) : e.summary ? (
          <div className={styles.summ}>{e.summary}</div>
        ) : null}

        {/* Small warning note when vision enrichment was skipped for this event */}
        {e.enrichment_skipped && (
          <div className={styles.skipNote}>
            vision enrichment skipped ({e.enrichment_skipped})
          </div>
        )}

        {/* Tag row: track IDs, episode length, plate hash, vehicle description */}
        <div className={styles.row3}>
          {/* "#1 / #2" track-id chip */}
          {e.track_ids?.length ? (
            <Tag variant="track">#{e.track_ids.join(" / #")}</Tag>
          ) : null}
          {/* Episode-duration chip */}
          {e.episode_duration_sec != null && (
            <Tag>ep {Number(e.episode_duration_sec).toFixed(1)}s</Tag>
          )}
          {/* Salted plate hash chip (shown when redaction is on) */}
          {enr?.plate_hash && (
            <Tag variant="hash" title="salted plate hash">
              {enr.plate_hash}
            </Tag>
          )}
          {/* Fallback plate-readability chip when no hash is available */}
          {!enr?.plate_hash && enr?.readability && (
            <Tag variant="muted">plate {enr.readability}</Tag>
          )}
          {/* Vehicle colour + type chip e.g. "white sedan" */}
          {(enr?.vehicle_color || enr?.vehicle_type) && (
            <Tag>
              {[enr.vehicle_color, enr.vehicle_type].filter(Boolean).join(" ")}
            </Tag>
          )}
        </div>

        {/* ID row at the bottom: event ID chip and video ID chip */}
        <div className={styles.row3}>
          <Tag>{e.event_id || ""}</Tag>
          <Tag>{e.video_id || ""}</Tag>
        </div>

        {/* Feedback buttons: "Correct" / "False alarm" — the only interactive part */}
        <FeedbackButtons eventId={e.event_id} />
      </div>
    </div>
  );
}
