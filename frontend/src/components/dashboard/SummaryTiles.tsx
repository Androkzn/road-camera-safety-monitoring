/**
 * SummaryTiles.tsx — row of four KPI tiles at the top of the Dashboard.
 *
 * What it does:
 *   Renders four boxes: total events, high-risk count (red accent),
 *   medium-risk count (amber accent), and formatted uptime (e.g. "2h 14m").
 *
 * Purpose:
 *   One-glance situational awareness for the operator: how busy is the
 *   stream, how severe is the traffic, how long has the server been up.
 *
 * How it works:
 *   - Props: `total`, `high`, `medium` are numeric counts computed upstream
 *     in the dashboard's event hook; `uptimeSec` is a number (or null when
 *     unknown) representing seconds since server start.
 *   - `formatUptime(uptimeSec)` is a pure helper from `lib/format` that
 *     turns seconds into a short human string.
 *   - The union type `number | null | undefined` in the prop means the
 *     value is a number, or explicitly missing — TypeScript forces us to
 *     handle both cases.
 *   - No state and no effects: the component is purely presentational.
 *
 * Connects to:
 *   - Backend: none directly — it only renders props. Counts come from
 *     `useEventStream` (SSE `/api/live/events/stream`) and `uptimeSec` is
 *     computed from `/api/live/status` in the parent.
 *   - UI: rendered by `pages/DashboardPage.tsx` at the top of the main
 *     panel, above the perception/scene/drift banners.
 */
import { formatUptime } from "../../lib/format";
import styles from "./SummaryTiles.module.css";

// Props:
// total      — total event count shown in the first neutral tile
// high       — high-risk count shown in the red tile
// medium     — medium-risk count shown in the amber tile
// uptimeSec  — server uptime in seconds; `?` means optional; `| null` means it can also be explicitly null until /api/live/status responds
interface SummaryTilesProps {
  total: number;
  high: number;
  medium: number;
  uptimeSec?: number | null;
}

// Renders the row of four KPI tiles at the top of the Dashboard page,
// directly above the perception/scene/drift banners.
export function SummaryTiles({ total, high, medium, uptimeSec }: SummaryTilesProps) {
  return (
    // Horizontal row of four tiles
    <div className={styles.summary}>
      {/* Tile 1 — neutral "Events" total */}
      <div className={styles.tile}>
        <div className={styles.label}>Events</div>
        <div className={styles.value}>{total}</div>
      </div>
      {/* Tile 2 — red-accented "High risk" count */}
      <div className={`${styles.tile} ${styles.high}`}>
        <div className={styles.label}>High risk</div>
        <div className={styles.value}>{high}</div>
      </div>
      {/* Tile 3 — amber-accented "Medium risk" count */}
      <div className={`${styles.tile} ${styles.medium}`}>
        <div className={styles.label}>Medium risk</div>
        <div className={styles.value}>{medium}</div>
      </div>
      {/* Tile 4 — neutral "Uptime" formatted as e.g. "2h 14m" via the shared helper */}
      <div className={styles.tile}>
        <div className={styles.label}>Uptime</div>
        <div className={styles.value}>{formatUptime(uptimeSec)}</div>
      </div>
    </div>
  );
}
