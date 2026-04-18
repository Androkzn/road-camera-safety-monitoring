/**
 * EventCard — public-facing card for one SafetyEvent. Larger and richer than
 * AdminEventCard: it shows an enrichment row (vehicle color/type, plate hash),
 * and embeds FeedbackButtons so viewers can mark the detection correct or wrong.
 *
 * Rendered by: DashboardPage (and anywhere else we list public events).
 *              See frontend/src/pages/DashboardPage.tsx.
 * Sibling:     AdminEventCard (./AdminEventCard.tsx) — denser admin variant.
 *
 * Data source: The parent page consumes the SSE stream `/api/live/stream` and
 *              passes each event down. See frontend/src/hooks/ for the hook
 *              that owns the connection.
 *
 * React concepts first taught here (continuing from AdminEventCard):
 *   - `useState` for local UI flags (the "flash-on-new" highlight).
 *   - `useEffect` with a cleanup function (clearTimeout on unmount / dep change).
 *   - Optional props (`isNew?: boolean`).
 *   - Passing a callback-free prop down to a child component (eventId → FeedbackButtons).
 *   - Chained conditional rendering: ternary ladder for "narration || summary || nothing".
 *   - className composition with a conditional modifier.
 */

import { useState, useEffect } from "react";
import type { SafetyEvent } from "../../types";
import { RiskBadge, Tag } from "../ui";
import { FeedbackButtons } from "./FeedbackButtons";
import {
  formatWallTime,
  humanEventType,
  formatConfidence,
  normalizeThumbnail,
} from "../../lib/format";
import styles from "./EventCard.module.css";

// --- Types ---

// TEACH: The `?` suffix marks a prop as optional. Parents may omit `isNew`,
// and it will arrive as `undefined` inside the component.
interface EventCardProps {
  event: SafetyEvent;
  isNew?: boolean;
}

// --- Component ---

export function EventCard({ event: e, isNew }: EventCardProps) {
  // --- State ---

  // TEACH: `useState(initial)` — if `isNew` is true on first render, we start
  // with `flash = true`, which adds a highlight CSS class. A short timer below
  // flips it back to false for a fade-out effect.
  const [flash, setFlash] = useState(isNew);

  // --- Effects ---

  // TEACH: `useEffect(fn, deps)` runs `fn` AFTER the component renders.
  //   - If `deps` is `[]`, it runs once after mount.
  //   - If `deps` contains values, it re-runs whenever any of those change.
  //   - The function may RETURN a cleanup function, which React calls before
  //     the next effect run or when the component unmounts.
  //
  // Here: when `isNew` is true, set a 1500ms timer to turn the flash off.
  // The returned `clearTimeout` ensures that if the component unmounts (or
  // `isNew` changes) before the timer fires, we don't leak a pending timer.
  useEffect(() => {
    if (!isNew) return;
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [isNew]);

  // --- Derived values ---

  const thumb = normalizeThumbnail(e.thumbnail);
  // TEACH: `arr?.length ? ... : ...` — truthiness-check shorthand. If the
  // array exists and has items, join them; otherwise fall back to "—".
  const objs = e.objects?.length ? e.objects.join(" · ") : "—";
  const enr = e.enrichment;

  // --- Render ---

  return (
    // TEACH: Class composition via template literal. `styles.card` is always
    // present; `styles.flash` only when the `flash` flag is true.
    <div className={`${styles.card} ${flash ? styles.flash : ""}`}>
      <div className={styles.thumb}>
        {thumb ? (
          <img
            src={thumb}
            alt=""
            // TEACH: When the image fails, hide the <img> and drop fallback
            // text into its parent. Same DOM-escape-hatch pattern as in
            // AdminEventCard — fine for a purely visual fallback.
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
        {/* Top row: risk level, event type, wall-clock + T+offset. */}
        <div className={styles.row1}>
          <RiskBadge level={e.risk_level} />
          <span className={styles.etype}>{humanEventType(e.event_type)}</span>
          <span className={styles.meta}>
            <span>{formatWallTime(e.wall_time)}</span>
            <span className={styles.sep}>•</span>
            <span>
              {/* TEACH: Inline ternary for a tiny conditional text node. */}
              {e.timestamp_sec != null ? `T+${Number(e.timestamp_sec).toFixed(1)}s` : ""}
            </span>
          </span>
        </div>

        {/* Objects + confidence line. */}
        <div className={styles.meta}>
          <span>{objs}</span>
          <span className={styles.sep}>•</span>
          <span>conf {formatConfidence(e.confidence)}</span>
        </div>

        {/* Kinematic tags — only rendered if any of the three are present.
            TEACH: `(a || b || c) && (...)` is a common pattern to avoid
            rendering the wrapper element when it'd be empty. */}
        {(e.ttc_sec != null || e.distance_m != null || e.distance_px != null) && (
          <div className={styles.meta}>
            {e.ttc_sec != null && (
              <Tag variant={e.ttc_sec <= 1.5 ? "kin-warn" : "kin"} title="time-to-collision">
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

        {/* TEACH: Ternary LADDER — render narration, else summary, else nothing.
            Notice the `null` leaf: returning `null` from JSX renders nothing. */}
        {e.narration ? (
          <div className={styles.narr}>{e.narration}</div>
        ) : e.summary ? (
          <div className={styles.summ}>{e.summary}</div>
        ) : null}

        {/* Optional note when the LLM enrichment was skipped for some reason. */}
        {e.enrichment_skipped && (
          <div className={styles.skipNote}>
            vision enrichment skipped ({e.enrichment_skipped})
          </div>
        )}

        {/* Track IDs, episode duration, plate hash / readability, vehicle tags. */}
        <div className={styles.row3}>
          {e.track_ids?.length ? (
            <Tag variant="track">#{e.track_ids.join(" / #")}</Tag>
          ) : null}
          {e.episode_duration_sec != null && (
            <Tag>ep {Number(e.episode_duration_sec).toFixed(1)}s</Tag>
          )}
          {/* TEACH: Privacy note — only a SALTED HASH of the plate ever
              reaches the frontend. The raw plate text is scrubbed server-side
              in `enrich_event()` (see road_safety/services/llm.py).
              Never add code that tries to fetch raw plates here. */}
          {enr?.plate_hash && (
            <Tag variant="hash" title="salted plate hash">
              {enr.plate_hash}
            </Tag>
          )}
          {!enr?.plate_hash && enr?.readability && (
            <Tag variant="muted">plate {enr.readability}</Tag>
          )}
          {(enr?.vehicle_color || enr?.vehicle_type) && (
            <Tag>
              {/* TEACH: `[a, b].filter(Boolean)` drops undefined/empty values
                  before joining — a concise way to skip missing fields. */}
              {[enr.vehicle_color, enr.vehicle_type].filter(Boolean).join(" ")}
            </Tag>
          )}
        </div>

        {/* Event + video IDs — useful for debugging / cross-referencing logs. */}
        <div className={styles.row3}>
          <Tag>{e.event_id || ""}</Tag>
          <Tag>{e.video_id || ""}</Tag>
        </div>

        {/* Feedback CTA. See ./FeedbackButtons.tsx.
            TEACH: We pass `eventId` down as a prop — the parent (us) knows the
            event, but the POST logic belongs to the child. That separation is
            React's whole philosophy: data flows down, callbacks bubble up. */}
        <FeedbackButtons eventId={e.event_id} />
      </div>
    </div>
  );
}
