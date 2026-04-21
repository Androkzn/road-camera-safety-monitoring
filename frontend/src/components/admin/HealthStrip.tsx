/**
 * HealthStrip.tsx — horizontal row of health cells across the Admin page top.
 *
 * What it does:
 *   Renders a single strip with one small cell per subsystem: Stream, Frames,
 *   Events, Perception, Scene, Tracker, LLM, Slack, Edge Pub, and PII.
 *   Each cell shows a label, a big value (e.g. "Active", "1,234 frames"),
 *   and a muted sub-line with supporting numbers. When no data is loaded
 *   yet, all cells show em-dashes.
 *
 * Purpose:
 *   Gives the operator a one-glance overview of whether every moving part
 *   of the pipeline is healthy right now.
 *
 * How it works:
 *   - Props: `health` is either the full `HealthData` object or `null`
 *     during initial load. When null, a placeholder strip renders.
 *   - Object destructuring (`const { server: srv, pipeline: pip, ... } =
 *     health`) pulls the sub-objects and renames them to short aliases.
 *   - Optional chaining and nullish coalescing protect against missing
 *     fields. The `.filter(Boolean).join(" / ")` pattern builds compact sub
 *     strings by dropping empty pieces.
 *   - `variant` drives CSS color classes (ok=green, warn=amber, err=red).
 *
 * Connects to:
 *   - Backend: data comes from `useAdminHealth` hook → `GET /api/admin/health`.
 *   - UI: rendered by `pages/AdminPage.tsx`, directly under `<TopBar>` and
 *     above the main video + sidebar layout.
 */
import type { HealthData } from "../../types";
import styles from "./HealthStrip.module.css";

// Props for one cell in the strip.
// label — small grey title text on top of the cell (e.g. "Stream").
// value — the big main number/word (e.g. "Active", "1,234").
// sub — optional muted line under the value with extra detail.
// variant — color tag (ok=green, warn=amber, err=red, accent=blue highlight).
interface HealthCellProps {
  label: string;
  value: string;
  sub?: string;
  variant?: "ok" | "warn" | "err" | "accent" | "";
}

// Helper component: one rectangular cell inside the strip.
// Renders label on top, value in the middle, optional sub line at the bottom.
function HealthCell({ label, value, sub, variant = "" }: HealthCellProps) {
  return (
    // Cell wrapper — one rectangle in the strip
    <div className={styles.hg}>
      {/* Small grey label at the top of the cell, e.g. "Stream" */}
      <div className={styles.label}>{label}</div>
      {/* Big main value text; template string joins the base class with the variant-specific color class */}
      <div className={`${styles.val} ${variant ? styles[variant] : ""}`}>{value}</div>
      {/* Muted sub-text under the value; `??` means "use \u00a0 (non-breaking space) when sub is null/undefined" so the row keeps its height */}
      <div className={styles.sub}>{sub ?? "\u00a0"}</div>
    </div>
  );
}

// Props for the whole strip. `health` is either the full data object, or
// null while the initial fetch is in flight.
interface HealthStripProps {
  health: HealthData | null;
}

// Renders the horizontal strip of health cells at the top of AdminPage, directly
// under the TopBar. One cell per subsystem (Stream/Frames/Events/Perception/Scene/
// Tracker/LLM/Slack/Edge Pub/PII).
export function HealthStrip({ health }: HealthStripProps) {
  // `{cond && <X/>}`-style early return: before data arrives, show a skeleton
  // strip with em-dashes so the layout doesn't jump when real data comes in.
  if (!health) {
    return (
      // Placeholder strip — shown only on first load, before /api/admin/health responds
      <div className={styles.strip}>
        <HealthCell label="Stream" value="—" />
        <HealthCell label="Frames" value="—" variant="accent" />
        <HealthCell label="Events" value="0" />
        <HealthCell label="Perception" value="—" />
        <HealthCell label="Scene" value="—" />
        <HealthCell label="Tracker" value="—" variant="accent" />
        <HealthCell label="LLM" value="—" />
        <HealthCell label="Slack" value="—" />
        <HealthCell label="Edge Pub" value="—" />
        <HealthCell label="PII" value="—" variant="ok" />
      </div>
    );
  }

  // Object destructuring with renaming: pulls sub-objects out of `health` and
  // gives them short local names (srv, pip, intg, perc, sc) for readability below.
  const { server: srv, pipeline: pip, integrations: intg, perception: perc, scene: sc } = health;

  return (
    // Main strip — the real health row, rendered once health data has loaded
    <div className={styles.strip}>
      {/* Stream cell: green "Active" when the ingestion loop is running, red "Down" otherwise; sub shows the source URL truncated to 50 chars */}
      <HealthCell
        label="Stream"
        value={srv.running ? "Active" : "Down"}
        variant={srv.running ? "ok" : "err"}
        sub={(srv.source || "").substring(0, 50)}
      />
      {/* Frames cell: total processed count as big number; sub shows "read / target fps". toLocaleString() formats with thousands separators. */}
      <HealthCell
        label="Frames"
        value={pip.frames_processed.toLocaleString()}
        variant="accent"
        sub={`${pip.frames_read.toLocaleString()} read / ${srv.target_fps} fps target`}
      />
      {/* Events cell: count of safety events so far; sub says how many episodes are still active; blue accent only when >0 */}
      <HealthCell
        label="Events"
        value={String(pip.event_count)}
        variant={pip.event_count > 0 ? "accent" : ""}
        sub={`${pip.active_episodes} active episode${pip.active_episodes !== 1 ? "s" : ""}`}
      />
      {/* Perception cell: model state ("nominal" = green, anything else = amber warn). Sub builds a "conf X / lum Y" line by filtering out empty pieces, or falls back to the raw reason. */}
      <HealthCell
        label="Perception"
        value={perc.state}
        variant={perc.state === "nominal" ? "ok" : "warn"}
        sub={
          [
            perc.avg_confidence != null ? `conf ${Number(perc.avg_confidence).toFixed(2)}` : "",
            perc.luminance != null ? `lum ${Math.round(perc.luminance)}` : "",
          ]
            .filter(Boolean)
            .join(" / ") || perc.reason
        }
      />
      {/* Scene cell: traffic-scene label (e.g. "street_level"); sub shows approximate speed and reason string */}
      <HealthCell
        label="Scene"
        value={sc.label}
        variant="accent"
        sub={
          [
            sc.speed_proxy_mps != null ? `~${sc.speed_proxy_mps} m/s` : "",
            sc.reason || "",
          ]
            .filter(Boolean)
            .join(" / ")
        }
      />
      {/* Tracker cell: name of the active tracker algorithm; sub shows the risk-scoring model name */}
      <HealthCell
        label="Tracker"
        value={pip.tracker}
        variant="accent"
        sub={pip.risk_model}
      />
      {/* LLM cell: On/Off depending on whether an LLM key is configured; green when On */}
      <HealthCell
        label="LLM"
        value={intg.llm_configured ? "On" : "Off"}
        variant={intg.llm_configured ? "ok" : ""}
      />
      {/* Slack cell: On/Off depending on whether a Slack webhook is configured */}
      <HealthCell
        label="Slack"
        value={intg.slack_configured ? "On" : "Off"}
        variant={intg.slack_configured ? "ok" : ""}
      />
      {/* Edge Pub cell: On/Off for the edge publisher integration (pushes events to an external bus) */}
      <HealthCell
        label="Edge Pub"
        value={intg.edge_publisher ? "On" : "Off"}
        variant={intg.edge_publisher ? "ok" : ""}
      />
      {/* PII cell: label describing the PII-redaction policy in effect; always shown green */}
      <HealthCell
        label="PII"
        value={intg.pii_redaction}
        variant="ok"
      />
    </div>
  );
}
