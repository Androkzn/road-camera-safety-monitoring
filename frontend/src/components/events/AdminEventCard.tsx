import type { SafetyEvent } from "../../types";
import { RiskBadge, Tag } from "../ui";
import { formatWallTime, humanEventType, normalizeThumbnail } from "../../lib/format";
import styles from "./AdminEventCard.module.css";

interface AdminEventCardProps {
  event: SafetyEvent;
}

export function AdminEventCard({ event: e }: AdminEventCardProps) {
  const thumb = normalizeThumbnail(e.thumbnail);
  const narr = e.narration || e.summary || "";

  return (
    <div className={styles.card}>
      <div className={styles.thumb}>
        {thumb ? (
          <img
            src={thumb}
            alt=""
            onError={(ev) => {
              (ev.target as HTMLImageElement).parentElement!.textContent = "—";
            }}
          />
        ) : (
          "—"
        )}
      </div>
      <div className={styles.info}>
        <div className={styles.top}>
          <RiskBadge level={e.risk_level} compact />
          <span className={styles.type}>{humanEventType(e.event_type)}</span>
          <span className={styles.time}>{formatWallTime(e.wall_time)}</span>
        </div>
        <div className={styles.metaRow}>
          {e.ttc_sec != null && (
            <Tag variant={e.ttc_sec <= 1.5 ? "kin-warn" : "kin"}>
              TTC {Number(e.ttc_sec).toFixed(1)}s
            </Tag>
          )}
          {e.distance_m != null && (
            <Tag variant="kin">{Number(e.distance_m).toFixed(1)}m</Tag>
          )}
          {e.distance_px != null && <Tag>{Math.round(e.distance_px)}px</Tag>}
          {e.track_ids?.length ? <Tag>#{e.track_ids.join("/")}</Tag> : null}
          {e.episode_duration_sec != null && (
            <Tag>ep {Number(e.episode_duration_sec).toFixed(1)}s</Tag>
          )}
        </div>
        {narr && (
          <div className={styles.narr} title={narr}>
            {narr}
          </div>
        )}
      </div>
    </div>
  );
}
