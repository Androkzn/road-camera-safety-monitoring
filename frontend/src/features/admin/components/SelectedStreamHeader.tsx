/**
 * SelectedStreamHeader — top-of-page summary for the currently focused
 * (or, when nothing is focused, the primary) perception stream.
 *
 * Sits between TopBar and HealthStrip on the Admin page. Lets operators
 * see the chosen camera's identity, running state, throughput, and
 * perception health without having to scan the tile grid.
 *
 * React/TS concepts first introduced in this file:
 *   - `interface Props` with optional `?` fields and callback props.
 *   - Custom hook consumption (`useUptimeTicker`) for a live-ticking value.
 *   - Nullish coalescing `??` vs `||` (the former only falls back on
 *     null/undefined — safer for "0 is valid" numbers).
 *   - Inline component declared below its parent (hoisting: `function`
 *     declarations are available everywhere in the module).
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: the title strip above the focused stream — shows the
 *   selected camera's name, hostname, running/paused state, uptime, and
 *   throughput numbers, plus a small "focused" badge when a tile was
 *   explicitly selected.
 */
import { useUptimeTicker } from "../../../shared/hooks/useUptimeTicker";
import type { LiveSourceStatus } from "../../../shared/types/common";

import styles from "./SelectedStreamHeader.module.css";

/** Collapse any URL to its bare hostname for the header's subtitle.
 *  Falls back to a truncated raw string if the URL parser throws. */
function shortHost(url: string): string {
  if (!url) return "—";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 48);
  }
}

/** Human-format a duration in seconds as "1h 2m 3s" / "2m 3s" / "5s". */
function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "0s";
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// TEACH: Union type `LiveSourceStatus | null` explicitly models the
// "no source yet" case so consumers must handle it — TypeScript will
// error if you try to read `.name` on a value that might be `null`.
interface SelectedStreamHeaderProps {
  source: LiveSourceStatus | null;
  // True when the source was chosen by an explicit tap; false when we
  // fell back to the primary. Drives the "focused" badge.
  isFocused: boolean;
  // Total configured sources — shown next to the name as context.
  totalSources: number;
  // TEACH: `() => void` is the type of a callback with no args and no
  // return value. The `?` makes it optional — the clear button is only
  // rendered when the parent wires a handler.
  onClear?: () => void;
}

/**
 * Renders the stream-identity bar. The component is data-light (no
 * fetching) — parents pass in the currently selected source and a
 * clear handler.
 */
export function SelectedStreamHeader({
  source,
  isFocused,
  totalSources,
  onClear,
}: SelectedStreamHeaderProps) {
  // Live-ticking uptime so the operator gets a heartbeat even when the
  // backend hasn't pushed a fresh snapshot in the last few seconds. We
  // only want the ticker to run while the source is actively running —
  // paused sources should freeze on their last `uptime_sec` snapshot.
  const startedAt = source?.started_at ?? null;
  const tickKey = source?.running ? startedAt : null;
  const elapsed = useUptimeTicker(tickKey);

  if (!source) {
    return (
      <div className={styles.bar}>
        <div className={styles.empty}>No streams configured</div>
      </div>
    );
  }

  const uptime = source.running && startedAt ? elapsed : source.uptime_sec;
  const perception = source.perception_state ?? "—";
  const perceptionWarn = perception !== "nominal" && perception !== "—";

  return (
    <div className={styles.bar}>
      <div className={styles.identity}>
        <span
          className={`${styles.dot} ${source.running ? styles.dotRunning : styles.dotPaused}`}
          aria-hidden
        />
        <div className={styles.nameWrap}>
          <div className={styles.nameRow}>
            <strong className={styles.name} title={source.name}>
              {source.name}
            </strong>
            {isFocused ? (
              <span className={styles.focusBadge}>focused</span>
            ) : (
              <span className={styles.primaryBadge}>primary</span>
            )}
            {!source.detection_enabled && (
              <span className={styles.detectionOff}>detection off</span>
            )}
          </div>
          <div className={styles.host} title={source.url}>
            {shortHost(source.url)} · {totalSources} stream
            {totalSources === 1 ? "" : "s"} total
          </div>
        </div>
      </div>

      <div className={styles.stats}>
        <Stat label="status" value={source.running ? "running" : "paused"} />
        <Stat label="uptime" value={formatUptime(uptime)} />
        <Stat
          label="frames"
          value={`${source.frames_processed.toLocaleString()} / ${source.frames_read.toLocaleString()}`}
          hint="processed / read"
        />
        <Stat label="active" value={String(source.active_episodes)} hint="open episodes" />
        <Stat
          label="perception"
          value={perception}
          warn={perceptionWarn}
          hint={source.perception_reason ?? undefined}
        />
      </div>

      {isFocused && onClear && (
        <button
          type="button"
          className={styles.clearBtn}
          onClick={onClear}
          title="Restore the multi-stream grid (Esc)"
        >
          Restore grid
        </button>
      )}

      {source.last_error && (
        <div className={styles.error} title={source.last_error}>
          {source.last_error}
        </div>
      )}
    </div>
  );
}

// TEACH: Inline Props type — instead of a named `interface`, the props
// shape is written directly in the parameter list. Fine for tiny
// private components like this; prefer a named interface once the
// component is exported or grows past a few props.
/** Single label/value pill in the stats row. `warn` adds an error tint. */
function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className={styles.stat} title={hint}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${warn ? styles.warn : ""}`}>{value}</span>
    </div>
  );
}
