import type { HealthData } from "../../types";
import styles from "./HealthStrip.module.css";

interface HealthCellProps {
  label: string;
  value: string;
  sub?: string;
  variant?: "ok" | "warn" | "err" | "accent" | "";
}

function HealthCell({ label, value, sub, variant = "" }: HealthCellProps) {
  return (
    <div className={styles.hg}>
      <div className={styles.label}>{label}</div>
      <div className={`${styles.val} ${variant ? styles[variant] : ""}`}>{value}</div>
      <div className={styles.sub}>{sub ?? "\u00a0"}</div>
    </div>
  );
}

interface HealthStripProps {
  health: HealthData | null;
}

export function HealthStrip({ health }: HealthStripProps) {
  if (!health) {
    return (
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

  const { server: srv, pipeline: pip, integrations: intg, perception: perc, scene: sc } = health;

  return (
    <div className={styles.strip}>
      <HealthCell
        label="Stream"
        value={srv.running ? "Active" : "Down"}
        variant={srv.running ? "ok" : "err"}
        sub={(srv.source || "").substring(0, 50)}
      />
      <HealthCell
        label="Frames"
        value={pip.frames_processed.toLocaleString()}
        variant="accent"
        sub={`${pip.frames_read.toLocaleString()} read / ${srv.target_fps} fps target`}
      />
      <HealthCell
        label="Events"
        value={String(pip.event_count)}
        variant={pip.event_count > 0 ? "accent" : ""}
        sub={`${pip.active_episodes} active episode${pip.active_episodes !== 1 ? "s" : ""}`}
      />
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
      <HealthCell
        label="Tracker"
        value={pip.tracker}
        variant="accent"
        sub={pip.risk_model}
      />
      <HealthCell
        label="LLM"
        value={intg.llm_configured ? "On" : "Off"}
        variant={intg.llm_configured ? "ok" : ""}
      />
      <HealthCell
        label="Slack"
        value={intg.slack_configured ? "On" : "Off"}
        variant={intg.slack_configured ? "ok" : ""}
      />
      <HealthCell
        label="Edge Pub"
        value={intg.edge_publisher ? "On" : "Off"}
        variant={intg.edge_publisher ? "ok" : ""}
      />
      <HealthCell
        label="PII"
        value={intg.pii_redaction}
        variant="ok"
      />
    </div>
  );
}
