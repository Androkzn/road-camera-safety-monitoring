/**
 * SettingsPage — operator-facing tuning console.
 *
 * Layout (works at any width):
 *   [TopBar]
 *   ┌─────────────────────────────┬──────────────────┐
 *   │ Page header                 │ Templates        │
 *   │ Validation errors / warns   │ Baseline         │
 *   │ <details> per category      │ Impact           │
 *   │   tunable rows…             │ (Live preview,   │
 *   │ [sticky apply bar]          │  collapsed)      │
 *   └─────────────────────────────┴──────────────────┘
 *
 * Below 1100px the right rail wraps under the tunables column so we never
 * get horizontal overflow or a hidden settings panel.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TopBar } from "../components/layout/TopBar";
import { useAdminToken } from "../hooks/useAdminToken";
import { useImpact } from "../hooks/useImpact";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useSettings } from "../hooks/useSettings";
import { useSettingsTemplates } from "../hooks/useSettingsTemplates";
import { useDialog } from "../components/ui/Dialog";
import {
  type AdminApiError,
  MissingAdminTokenError,
  adminFetch,
} from "../lib/adminApi";
import type {
  ApplyResultPayload,
  ConfidenceTier,
  ImpactReport,
  SettingSpec,
  SettingsTemplate,
} from "../types";

import styles from "./SettingsPage.module.css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type DraftValue = number | string | boolean;

function isPrivacyConfirmRequired(exc: unknown): boolean {
  return (
    !!exc &&
    typeof exc === "object" &&
    (exc as AdminApiError).status === 400 &&
    (exc as AdminApiError).body !== null &&
    typeof (exc as AdminApiError).body === "object" &&
    ((exc as AdminApiError).body as { error?: string }).error === "privacy_confirm_required"
  );
}

function extractValidationErrors(exc: unknown): Array<{ key: string; reason: string }> | null {
  if (
    exc &&
    typeof exc === "object" &&
    (exc as AdminApiError).status === 422 &&
    (exc as AdminApiError).body !== null &&
    typeof (exc as AdminApiError).body === "object"
  ) {
    const body = (exc as AdminApiError).body as { errors?: Array<{ key: string; reason: string }> };
    return body.errors ?? null;
  }
  return null;
}

function tierClass(tier: ConfidenceTier): string {
  switch (tier) {
    case "high": return styles.tierHigh ?? "";
    case "medium": return styles.tierMedium ?? "";
    case "low": return styles.tierLow ?? "";
    default: return styles.tierInsufficient ?? "";
  }
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v).toFixed(digits);
}

/**
 * Pick a clean step for a numeric tunable. Honours an explicit ``spec.step``
 * when set; otherwise picks the largest "nice" increment (1, 0.5, 0.1,
 * 0.05, 0.01, …) that yields at least 20 slider stops over the range. This
 * keeps the slider responsive without producing values like ``5.0125``.
 */
function stepFor(spec: SettingSpec, min: number, max: number): number {
  if (spec.step != null && spec.step > 0) return spec.step;
  if (spec.type === "int") return 1;
  const range = Math.max(max - min, 0.0001);
  const candidates = [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01];
  for (const c of candidates) {
    if (range / c >= 20) return c;
  }
  return 0.01;
}

/**
 * Per-token rewrite map for humanizing SCREAMING_SNAKE keys. Covers
 * industry acronyms operators recognise (kept uppercase) and truncated
 * words we expand into English. Unit suffixes (M, SEC, FPS, …) are
 * handled separately by :func:`unitFromTail` so the label reads
 * "Distance High, m" instead of "Distance High M".
 */
/**
 * Per-token rewrite map. Operator preference is to spell every abbreviation
 * out fully — labels read like English, not config keys.
 */
const TOKEN_REWRITES: Record<string, string> = {
  // Domain expansions
  TTC: "Time to Collision",
  ALPR: "License Plate Recognition",
  LLM: "LLM",
  CB: "Circuit Breaker",
  BBOX: "Bounding Box",
  CONF: "Confidence",
  DIST: "Distance",
  LUM: "Luminance",
  LEN: "Length",
  MED: "Medium",
  // Statistical / metric tokens used by the impact engine
  FP: "FP",
  TP: "TP",
  // Common short words — fully spelled out
  MIN: "Minimum",
  MAX: "Maximum",
  // Industry-pronounced acronym kept as-is; "Identifier" sounds clinical.
  ID: "ID",
};

/**
 * Unit suffix tokens. When a key ends with one (optionally preceded by
 * ``PER``), the unit is split off and appended after a comma — e.g.
 * ``DIST_HIGH_M`` → "Distance High, meters",
 * ``LLM_BUCKET_REFILL_PER_MIN`` → "Large Language Model Bucket Refill, per minute".
 */
const UNIT_TOKENS: Record<string, string> = {
  M: "meters",
  SEC: "seconds",
  FPS: "frames per second",
  MS: "milliseconds",
  HZ: "Hertz",
  PCT: "percent",
};

function unitFromTail(tokens: string[]): { unit: string | null; consume: number } {
  if (tokens.length === 0) return { unit: null, consume: 0 };
  const last = (tokens[tokens.length - 1] ?? "").toUpperCase();
  // ``PER`` + time unit composes into "per <unit>"
  if (tokens.length >= 2 && (tokens[tokens.length - 2] ?? "").toUpperCase() === "PER") {
    if (last === "MIN") return { unit: "per minute", consume: 2 };
    if (last === "SEC") return { unit: "per second", consume: 2 };
    if (last === "HOUR") return { unit: "per hour", consume: 2 };
  }
  if (UNIT_TOKENS[last]) return { unit: UNIT_TOKENS[last]!, consume: 1 };
  return { unit: null, consume: 0 };
}

/**
 * Convert ``SOME_KEY_NAME`` (or ``some-thing``) to a human label.
 * E.g.
 *   ``DIST_HIGH_M``                 → "Distance High, m"
 *   ``TTC_HIGH_SEC``                → "TTC High, s"
 *   ``LLM_BUCKET_REFILL_PER_MIN``   → "LLM Bucket Refill, per min"
 *   ``MIN_BBOX_AREA``               → "Min BBox Area"
 *   ``VEHICLE_PAIR_CONF_FLOOR``     → "Vehicle Pair Confidence Floor"
 *   ``risk-tier``                   → "Risk Tier"
 */
function humanizeToken(word: string): string {
  const upper = word.toUpperCase();
  if (TOKEN_REWRITES[upper] !== undefined) return TOKEN_REWRITES[upper];
  // Percentile shorthand like P50 / P95 / P99 — stylised as lowercase.
  if (/^P\d+$/.test(upper)) return upper.toLowerCase();
  const lower = word.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function humanize(raw: string): string {
  const tokens = raw.split(/[_\-\s]+/).filter(Boolean);
  const { unit, consume } = unitFromTail(tokens);
  const head = consume > 0 ? tokens.slice(0, tokens.length - consume) : tokens;
  const headLabel = head.map(humanizeToken).join(" ");
  return unit ? `${headLabel}, ${unit}` : headLabel;
}

/** Friendlier label for the impact-session lifecycle state. */
function formatState(state: string): string {
  if (state === "monitoring_unattended") return "Monitoring (unattended)";
  return humanize(state);
}

// ---------------------------------------------------------------------------
// Per-tunable help text — operator-facing explanations beyond the one-line
// description carried in the spec. Keyed by the raw setting name.
// ---------------------------------------------------------------------------
interface TunableHelp {
  what: string;
  affects: string;
  increase?: string;
  decrease?: string;
  options?: Record<string, string>;
}

const TUNABLE_HELP: Record<string, TunableHelp> = {
  CONF_THRESHOLD: {
    what: "Minimum YOLO confidence required for a vehicle detection to enter the pipeline.",
    affects: "Detection ingest funnel — applied per-frame before any TTC, distance or pair gate.",
    increase: "Fewer detections; reduces false positives from billboards / shadows / odd-shaped trash. May miss distant or low-contrast vehicles.",
    decrease: "More detections including marginal ones. Adds load to LLM enrichment and downstream gates; may admit noise that scene-context can't fully suppress.",
  },
  PERSON_CONF_THRESHOLD: {
    what: "Minimum YOLO confidence for the person class.",
    affects: "Pedestrian detection only — vehicles use CONF_THRESHOLD.",
    increase: "Fewer false-positive 'person' boxes from occlusion bleed. Risks missing distant or partially-occluded pedestrians (which legitimately score lower).",
    decrease: "Catches more distant / partially-visible people. Below ~0.25 with YOLOv8n it lets occasional noise through; pair with a larger model variant if you go aggressive.",
  },
  VEHICLE_PAIR_CONF_FLOOR: {
    what: "Mean of two detection confidences required before a vehicle-vehicle pair becomes an event candidate.",
    affects: "Vehicle ↔ vehicle close-interaction events (pedestrian pairs are unaffected).",
    increase: "Fewer car-on-car alerts; kills the 'two low-confidence blobs that happen to overlap' false positive — historically the largest alert-fatigue source.",
    decrease: "More vehicle-pair alerts. Use only if your camera reliably yields high-confidence vehicle bboxes.",
  },
  MIN_BBOX_AREA: {
    what: "Minimum bounding-box area in square pixels for a vehicle detection to count.",
    affects: "Vehicle ingest filter — pedestrians have their own (smaller) PERSON_MIN_BBOX_AREA constant.",
    increase: "Rejects far-field tiny vehicles. Lower compute load, less far-field reach.",
    decrease: "Catches more distant vehicles but admits jitter / noise blobs that the geometry gates have to clean up.",
  },
  TTC_HIGH_SEC: {
    what: "Time-to-collision threshold (in seconds) at or below which an interaction is classified HIGH risk.",
    affects: "Risk tier of every emitted event; high-tier events trigger Slack pings.",
    increase: "More events classified HIGH. At 1.0s anything within one second of contact is high; at 0.5s it's essentially 'already colliding'.",
    decrease: "Stricter HIGH classification. Fewer Slack high-tier alerts; only the most imminent collisions fire.",
  },
  TTC_MED_SEC: {
    what: "Time-to-collision threshold at or below which an interaction is classified MEDIUM (above HIGH).",
    affects: "Dashboard highlight tier; medium events accumulate into the hourly Slack digest, not real-time pings.",
    increase: "More events promoted to MEDIUM rather than logged silently as LOW.",
    decrease: "Tighter MEDIUM band; more events demoted to LOW.",
  },
  DIST_HIGH_M: {
    what: "Inter-object 3D distance (in metres) at or below which an interaction is classified HIGH risk.",
    affects: "Same risk-tier cascade as TTC_HIGH_SEC, but using the depth-prior distance estimate.",
    increase: "More events classified HIGH purely on proximity. At 5m nearly any two vehicles in the same frame trip the gate.",
    decrease: "Only very close interactions (within arm's reach) trigger HIGH on distance alone.",
  },
  DIST_MED_M: {
    what: "Inter-object distance threshold for MEDIUM risk (above DIST_HIGH_M).",
    affects: "Medium-tier dashboard signal; combined with TTC_MED_SEC by worst-signal-wins.",
    increase: "More events in the MEDIUM band on proximity.",
    decrease: "Tighter MEDIUM proximity threshold.",
  },
  MIN_SCALE_GROWTH: {
    what: "Minimum bounding-box scale-expansion ratio over the trailing window before TTC will publish a value.",
    affects: "TTC computation — the 'is this object actually approaching' gate.",
    increase: "Stricter approach evidence; kills 'jittery stationary box' false TTC alerts. Risks missing slow approaches.",
    decrease: "TTC fires for smaller scale changes; more sensitivity, more jitter-driven false alerts. Below 1.05 you start emitting TTC for bbox noise alone.",
  },
  TRACK_HISTORY_LEN: {
    what: "Number of trailing samples kept per tracked object for TTC math.",
    affects: "TTC stability and responsiveness; longer history smooths estimates and is required for sustained-growth detection.",
    increase: "More stable TTC estimates and longer lookback for sustained-growth checks. Slightly more memory per active track and slower adaptation to new fast-moving objects.",
    decrease: "Faster reaction to brand-new tracks. Risks falling below the multi-gate sustained-growth sample-count requirement, which silently disables TTC for short-lived tracks.",
  },
  QUALITY_BLUR_SHARP: {
    what: "Laplacian-variance value below which the camera is classified as blurred (dirty lens / motion blur / fog).",
    affects: "QualityMonitor state machine — degraded states suppress event emission and widen TTC thresholds.",
    increase: "Stricter sharpness requirement; pipeline degrades into 'blurred' more often, suppressing events. Use when the lens is reliably clean and you want extra safety on borderline frames.",
    decrease: "More permissive — runs through more frames without suppression but admits blurry false positives.",
  },
  QUALITY_LOW_LIGHT_LUM: {
    what: "Mean grayscale luminance below which the scene is classified as low-light.",
    affects: "QualityMonitor degradation; below the threshold YOLO recall drops sharply on COCO classes.",
    increase: "Stricter light requirement; degrades into low-light suppression earlier (more events suppressed at dusk / under bridges).",
    decrease: "Tolerates darker scenes; risks acting on noisy detections from a dim sensor.",
  },
  LLM_BUCKET_CAPACITY: {
    what: "Burst capacity (whole tokens) of the shared LLM rate-limit bucket. Each enrichment costs 2 tokens, each narration costs 1.",
    affects: "How many LLM calls can fire back-to-back during an event burst before throttling kicks in.",
    increase: "Larger LLM bursts during event clusters. Higher peak cost and risk of 429s if you exceed the provider's rate limit.",
    decrease: "More aggressive throttling — non-essential narration / enrichment skipped during bursts. Lower cost, more 'rate budget exhausted' skip records in /api/llm/stats.",
  },
  LLM_BUCKET_REFILL_PER_MIN: {
    what: "Sustained refill rate of the LLM bucket in tokens per minute.",
    affects: "Long-run LLM call rate and cost.",
    increase: "Higher sustained LLM call rate, higher cost. Stay below the provider's rate limit (Anthropic Haiku low-tier ≈ 5 req/min).",
    decrease: "Lower sustained call rate; more events get the deterministic narration fallback rather than an LLM-generated one.",
  },
  SLACK_HIGH_MIN_CONFIDENCE: {
    what: "Peak event confidence required before a HIGH-risk event becomes a Slack high-tier ping.",
    affects: "Slack #high channel — operator paging tier. Medium / low events go to digests instead.",
    increase: "Fewer real-time Slack pings; only the most confident HIGH events page operators.",
    decrease: "More real-time pings. If your model has been drifting noisy, lowering this risks alert fatigue on the responder team.",
  },
  ALPR_MODE: {
    what: "Posture for the external license-plate-recognition service.",
    affects: "Privacy footprint, LLM cost, and what data leaves the edge.",
    options: {
      off: "No external ALPR calls. Plate text never leaves the edge. Safest privacy posture; the default.",
      on: "Every event triggers an ALPR call. Maximum recall, maximum cost, plate text crosses to the provider for every event.",
      on_demand: "ALPR only fires when an event is explicitly flagged for review. Balanced posture; cost scales with operator review rate, not event rate.",
    },
  },
  PAIR_COOLDOWN_SEC: {
    what: "After emitting an event for a (track A, track B) pair, suppress further events from the same pair for this many seconds.",
    affects: "Event-stream noise — without this a single sustained near-miss would emit ~20 events.",
    increase: "Fewer duplicate events; cleaner stream during sustained interactions. Risks coalescing two genuinely separate close-calls between the same pair into one report.",
    decrease: "More granular reporting on evolving incidents. Risks spamming the SSE stream and Slack on long sustained near-misses.",
  },
  MAX_RECENT_EVENTS: {
    what: "Capacity of the in-memory ring buffer of recent events.",
    affects: "How much history the dashboard, agents and impact engine can see without going to disk.",
    increase: "Longer event history available to UI and impact comparisons. More RAM (linearly).",
    decrease: "Smaller footprint. Less history for the impact engine, agents and the SSE replay-on-connect.",
  },
  TARGET_FPS: {
    what: "Perception-loop tick rate. Drives how often YOLO runs per stream second.",
    affects: "Latency to detect short-lived collisions versus CPU / GPU / LLM cost.",
    increase: "Faster reaction to motorbike cut-ins and other short TTC windows. Higher CPU and LLM budget burn.",
    decrease: "Lower compute load and LLM headroom. Risks missing sub-second TTC events. Below 1 fps the multi-gate sustained-growth requirement starts struggling for sample volume.",
  },
};

/**
 * Pretty labels for impact-engine metric keys (e.g. ``event_rate_per_min``).
 * Falls back to title-cased :func:`humanize` for any key not in the map.
 */
const METRIC_LABELS: Record<string, string> = {
  event_rate_per_min: "Events / min",
  confidence_p50: "Confidence p50",
  confidence_p95: "Confidence p95",
  ttc_p50: "TTC p50",
  ttc_p95: "TTC p95",
  distance_p50_m: "Distance p50, m",
  distance_p95_m: "Distance p95, m",
  sample_size: "Sample size",
  fp_rate: "False-positive rate",
  drift_precision: "Drift precision",
  feedback_coverage: "Feedback coverage",
  llm_cost_usd_per_min: "LLM cost, $ / min",
  llm_latency_p95_ms: "LLM latency p95, ms",
  llm_skip_rate: "LLM skip rate",
  enrichment_skipped_rate: "Enrichment skipped rate",
  episode_duration_mean: "Episode duration, mean",
  episode_duration_p95: "Episode duration p95",
  frames_processed_ratio: "Frames processed ratio",
};

function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? humanize(key);
}

/**
 * Reason codes returned by the comparability gate (e.g.
 * ``insufficient_events``, ``scene_mix_drift``). Renders as plain English.
 */
const REASON_LABELS: Record<string, string> = {
  insufficient_events: "Insufficient events",
  scene_mix_drift: "Scene mix drifted",
  quality_drift: "Quality drifted",
  no_baseline_or_after: "No baseline or after-window yet",
};

function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? humanize(key);
}

const SEVERITY_LABELS: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

function severityLabel(key: string): string {
  return SEVERITY_LABELS[key] ?? humanize(key);
}

function shortSource(src: string): string {
  if (!src) return "—";
  if (/youtube\.com|youtu\.be/.test(src)) return "youtube";
  if (src.startsWith("http")) {
    try { return new URL(src).hostname.replace(/^www\./, ""); } catch { return src.slice(0, 24); }
  }
  const seg = src.split("/").filter(Boolean).pop();
  return seg || src;
}

// ---------------------------------------------------------------------------
// TunableControl
// ---------------------------------------------------------------------------
function TunableControl(props: {
  spec: SettingSpec;
  effective: DraftValue;
  draft: DraftValue;
  errorReason: string | null;
  onChange: (v: DraftValue) => void;
}) {
  const { spec, effective, draft, errorReason, onChange } = props;
  const dirty = draft !== effective;
  const [helpOpen, setHelpOpen] = useState(false);
  const help = TUNABLE_HELP[spec.key];
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Viewport coords for the floating popover. We use ``position: fixed`` so
  // the popover escapes the scrolling .center column's clipping context.
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // Close on outside click / Escape — standard popover UX.
  useEffect(() => {
    if (!helpOpen) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (
        tgt &&
        !popoverRef.current?.contains(tgt) &&
        !triggerRef.current?.contains(tgt)
      ) {
        setHelpOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [helpOpen]);

  // Recompute the popover anchor whenever it opens, the user scrolls, or
  // the window is resized. Right/bottom edges flip the popover so it stays
  // on screen without going off the viewport.
  useLayoutEffect(() => {
    if (!helpOpen) {
      setPopoverPos(null);
      return;
    }
    const POPOVER_W = 340;
    const POPOVER_H_EST = 220;        // best-effort guess for edge clamping
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = r.bottom + 10;
      let left = r.left - 10;
      if (left + POPOVER_W > vw - 8) left = Math.max(8, vw - POPOVER_W - 8);
      if (top + POPOVER_H_EST > vh - 8) top = Math.max(8, r.top - POPOVER_H_EST - 10);
      setPopoverPos({ top, left });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [helpOpen]);
  const cls = [
    styles.tunable,
    dirty ? styles.dirty : "",
    errorReason ? styles.error : "",
  ].filter(Boolean).join(" ");

  let control: React.ReactNode;
  if (spec.type === "enum" && spec.enum) {
    control = (
      <select value={String(draft)} onChange={(e) => onChange(e.target.value)}>
        {spec.enum.map((v) => (
          <option key={v} value={v}>{humanize(v)}</option>
        ))}
      </select>
    );
  } else if (spec.type === "bool") {
    control = (
      <input type="checkbox" checked={!!draft} onChange={(e) => onChange(e.target.checked)} />
    );
  } else if (spec.type === "int" || spec.type === "float") {
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const step = stepFor(spec, min, max);
    const parse = (s: string) => {
      const n = spec.type === "int" ? parseInt(s, 10) : parseFloat(s);
      if (!Number.isFinite(n)) return spec.type === "int" ? 0 : 0;
      // Quantise to the chosen step so the displayed value never inherits
      // floating-point noise from the slider widget (e.g. 5.0125).
      const snapped = Math.round((n - min) / step) * step + min;
      // Round to the step's significant digits so we don't print 5.000000001.
      const digits = step >= 1 ? 0 : Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
      return Number(snapped.toFixed(digits));
    };
    control = (
      <>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) => onChange(parse(e.target.value))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) => onChange(parse(e.target.value))}
        />
      </>
    );
  } else {
    control = <input type="text" value={String(draft)} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className={cls}>
      <div className={styles.keyCol}>
        <span className={styles.keyLabel} title={spec.key}>
          {humanize(spec.key)}
          {help && (
            <span className={styles.helpAnchor}>
              <button
                ref={triggerRef}
                type="button"
                className={styles.infoBtn}
                aria-label={`More info about ${humanize(spec.key)}`}
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((o) => !o)}
              >
                i
              </button>
              {helpOpen && popoverPos && (
                <div
                  ref={popoverRef}
                  className={styles.helpPopover}
                  role="dialog"
                  style={{ top: popoverPos.top, left: popoverPos.left }}
                >
                  <button
                    type="button"
                    className={styles.helpClose}
                    aria-label="Close"
                    onClick={() => setHelpOpen(false)}
                  >
                    ×
                  </button>
                  <h4 className={styles.helpTitle}>{humanize(spec.key)}</h4>
                  <p><strong>What it is.</strong> {help.what}</p>
                  <p><strong>Affects.</strong> {help.affects}</p>
                  {help.increase && (
                    <p><strong>↑ Increasing.</strong> {help.increase}</p>
                  )}
                  {help.decrease && (
                    <p><strong>↓ Decreasing.</strong> {help.decrease}</p>
                  )}
                  {help.options && (
                    <ul className={styles.helpOptions}>
                      {Object.entries(help.options).map(([opt, txt]) => (
                        <li key={opt}>
                          <code>{opt}</code> — {txt}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </span>
          )}
        </span>
        <span className={styles.keyDesc}>{spec.description}</span>
        {errorReason && <span className={styles.keyError}>{errorReason}</span>}
      </div>
      <div className={styles.controlCol}>{control}</div>
      <div className={styles.metaCol}>
        <button
          type="button"
          className={styles.resetBtn}
          disabled={draft === spec.default}
          onClick={() => onChange(spec.default as DraftValue)}
          title={`Reset to spec default (${String(spec.default)})`}
        >
          Reset to {String(spec.default)}
        </button>
        {spec.mutability === "warm_reload" && <span className={`${styles.badge} ${styles.badgeWarm}`}>warm</span>}
        {spec.mutability === "restart_required" && <span className={`${styles.badge} ${styles.badgeRestart}`}>restart</span>}
        {spec.mutability === "read_only" && <span className={`${styles.badge} ${styles.badgeReadonly}`}>read-only</span>}
        {spec.requires_privacy_confirm && <span className={`${styles.badge} ${styles.badgePrivacy}`}>privacy</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplatesCard
// ---------------------------------------------------------------------------
function TemplatesCard(props: {
  templates: SettingsTemplate[];
  busy: boolean;
  onApply: (id: string) => Promise<void>;
  onCreate: (name: string, description: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const dialog = useDialog();

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Templates ({props.templates.length})</h3>
      </div>
      <div className={styles.templateList}>
        {props.templates.map((t) => (
          <div key={t.id} className={styles.templateItem}>
            <div className={styles.templateRow}>
              <div>
                <span className={styles.templateName}>{t.name}</span>
                {t.system && <span className={`${styles.badge} ${styles.badgeReadonly}`} style={{ marginLeft: 6 }}>system</span>}
              </div>
              <span className={styles.subtle}>r{t.latest_revision_no}</span>
            </div>
            {t.description && <span className={styles.templateDesc}>{t.description}</span>}
            <div className={styles.templateActions}>
              <button
                className={styles.btn}
                disabled={props.busy}
                onClick={() => props.onApply(t.id)}
              >
                Apply
              </button>
              {!t.system && (
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={props.busy}
                  onClick={async () => {
                    const ok = await dialog.confirm({
                      title: "Delete template",
                      message: `Soft-delete template "${t.name}"? Existing impact sessions that reference it stay intact.`,
                      okLabel: "Delete",
                      variant: "danger",
                    });
                    if (ok) props.onDelete(t.id);
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <details>
        <summary className={styles.subtle} style={{ cursor: "pointer" }}>+ Save current as template</summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <input
            className={styles.tokenInput}
            placeholder="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={styles.tokenInput}
            placeholder="Description (optional)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!name.trim() || creating}
            onClick={async () => {
              setCreating(true);
              try {
                await props.onCreate(name.trim(), desc.trim());
                setName(""); setDesc("");
              } finally {
                setCreating(false);
              }
            }}
          >
            {creating ? "Saving…" : "Save"}
          </button>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BaselineCard
// ---------------------------------------------------------------------------
function BaselineCard({ onCaptured }: { onCaptured: () => void }) {
  const [busy, setBusy] = useState(false);
  // Inline status string surfaced beneath the button. Null = idle. Without
  // this the operator clicks "Capture baseline now", the request returns
  // (success or 401), and nothing visible changes — the impact card on its
  // own can stay empty if the event buffer is small, so the user can't tell
  // whether the click did anything. We always show an explicit result.
  const [status, setStatus] = useState<
    | { kind: "ok"; auditId: string }
    | { kind: "err"; message: string }
    | null
  >(null);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Baseline</h3>
      </div>
      <p className={styles.subtle} style={{ margin: 0 }}>
        Snapshot the current event buffer. Future changes' impact is computed
        against this baseline.
      </p>
      <button
        className={styles.btn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setStatus(null);
          try {
            const res = await adminFetch<{ ok: boolean; audit_id: string }>(
              "/api/settings/baseline/capture",
              { method: "POST" },
            );
            setStatus({ kind: "ok", auditId: res.audit_id });
            onCaptured();
          } catch (exc) {
            if (exc instanceof MissingAdminTokenError) {
              setStatus({
                kind: "err",
                message:
                  "Admin token missing. Reload the page and paste your ROAD_ADMIN_TOKEN.",
              });
              return;
            }
            const status = (exc as AdminApiError).status;
            if (status === 401 || status === 403) {
              setStatus({
                kind: "err",
                message: `HTTP ${status} — token rejected. Re-paste your ROAD_ADMIN_TOKEN and try again.`,
              });
              return;
            }
            const body = (exc as AdminApiError).body as
              | { detail?: string; error?: string }
              | null;
            const detail =
              body?.detail || body?.error || (exc as Error).message || "unknown error";
            setStatus({ kind: "err", message: `Capture failed: ${detail}` });
            console.error("baseline capture failed", exc);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Capturing…" : "Capture baseline now"}
      </button>
      {status?.kind === "ok" && (
        <div className={styles.warnings} style={{ marginBottom: 0 }}>
          Baseline captured — session <code>{status.auditId.slice(0, 18)}</code>.
          The Impact card will populate as new events arrive.
        </div>
      )}
      {status?.kind === "err" && (
        <div className={styles.errorList} style={{ marginBottom: 0 }}>
          {status.message}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImpactCard
// ---------------------------------------------------------------------------
function ImpactCard(props: {
  report: ImpactReport | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const r = props.report;
  if (!r) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}><h3 className={styles.cardTitle}>Impact</h3></div>
        <p className={styles.subtle} style={{ margin: 0 }}>
          No active session yet. Apply a change or capture a baseline.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Impact ({humanize(r.state)})</h3>
        <span className={`${styles.confidenceTier} ${tierClass(r.confidence_tier)}`}>
          {humanize(r.confidence_tier)}
        </span>
      </div>

      {r.changed_keys.length > 0 && (
        <div className={styles.subtle} style={{ fontSize: 11 }}>
          {r.changed_keys.length} key{r.changed_keys.length === 1 ? "" : "s"} changed:{" "}
          {r.changed_keys.slice(0, 2).map(humanize).join(", ")}
          {r.changed_keys.length > 2 ? "…" : ""}
        </div>
      )}

      {r.confidence_reasons.length > 0 && (
        <div className={styles.reasonList}>
          {r.confidence_reasons.map((reason) => (
            <span key={reason} className={styles.reasonChip} title={reason}>
              {reasonLabel(reason)}
            </span>
          ))}
        </div>
      )}

      {r.baseline && r.after_window && (
        <>
          <div className={styles.deltaList}>
            <span>{metricLabel("event_rate_per_min")}</span>
            <span>{fmt(r.baseline.event_rate_per_min)} → {fmt(r.after_window.event_rate_per_min)}</span>
            <span className={(r.deltas.event_rate_per_min ?? 0) > 0 ? styles.deltaNeg : styles.deltaPos}>
              {fmt(r.deltas.event_rate_per_min, 1)}%
            </span>

            <span>{metricLabel("confidence_p50")}</span>
            <span>{fmt(r.baseline.confidence_p50)} → {fmt(r.after_window.confidence_p50)}</span>
            <span className={(r.deltas.confidence_p50 ?? 0) > 0 ? styles.deltaPos : styles.deltaNeg}>
              {fmt(r.deltas.confidence_p50, 1)}%
            </span>

            <span>{metricLabel("ttc_p95")}</span>
            <span>{fmt(r.baseline.ttc_p95)} → {fmt(r.after_window.ttc_p95)}</span>
            <span className={(r.deltas.ttc_p95 ?? 0) > 0 ? styles.deltaPos : styles.deltaNeg}>
              {fmt(r.deltas.ttc_p95, 1)}%
            </span>

            <span>{metricLabel("sample_size")}</span>
            <span>{r.baseline.sample_size} → {r.after_window.sample_size}</span>
            <span></span>
          </div>

          <SeverityBars label="Severity (after-change)" counts={r.after_window.severity_counts} />
        </>
      )}

      {r.narrative && (
        <div className={styles.narrative}>
          <strong>{(r.recommendation ?? "monitor").toUpperCase()}</strong>: {r.narrative}
        </div>
      )}

      <button className={styles.btn} onClick={props.onRefresh} disabled={props.refreshing}>
        {props.refreshing ? "Refreshing…" : "Refresh"}
      </button>

      {r.lagging_metrics.length > 0 && (
        <div className={styles.subtle} style={{ fontSize: 10 }}>
          Lagging metrics ({r.lagging_metrics.map(metricLabel).join(", ")}) need operator
          feedback before they populate.
        </div>
      )}
    </div>
  );
}

function SeverityBars({ label, counts }: { label: string; counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
  const order = ["high", "medium", "low", "unknown"];
  const seen = new Set<string>();
  return (
    <div>
      <div className={styles.subtle} style={{ marginBottom: 4 }}>{label}</div>
      <div className={styles.bars}>
        {order
          .filter((k) => counts[k] != null)
          .map((k) => {
            seen.add(k);
            const v = counts[k] ?? 0;
            return (
              <div className={styles.barRow} key={k}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>{severityLabel(k)}</div>
                  <div className={styles.bar}>
                    <div className={styles.barFill} style={{ width: `${(v / total) * 100}%` }} />
                  </div>
                </div>
                <span className={styles.subtle}>{v}</span>
              </div>
            );
          })}
        {Object.entries(counts)
          .filter(([k]) => !seen.has(k))
          .map(([k, v]) => (
            <div className={styles.barRow} key={k}>
              <div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>{severityLabel(k)}</div>
                <div className={styles.bar}>
                  <div className={styles.barFill} style={{ width: `${(v / total) * 100}%` }} />
                </div>
              </div>
              <span className={styles.subtle}>{v}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsPage
// ---------------------------------------------------------------------------
export function SettingsPage() {
  const { token, setToken, clear: clearToken } = useAdminToken();
  const settings = useSettings(token);
  const templates = useSettingsTemplates(token);
  const impact = useImpact(token);
  const { data: live, error: liveError } = useLiveStatus(5000);
  const dialog = useDialog();

  const connected: boolean | undefined =
    live ? !!live.running : liveError ? false : undefined;
  const sourceName = live?.source ? shortSource(live.source) : "—";

  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [validationErrors, setValidationErrors] = useState<Array<{ key: string; reason: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  // ``applyResult`` drives the success banner + structured console log after
  // every successful apply / rollback. We keep ``diff`` on it so the banner
  // can show exactly which keys changed without re-reading draft state after
  // setDraft({}) has cleared it.
  const [applyResult, setApplyResult] = useState<
    | {
        kind: "apply" | "rollback" | "template";
        diff: Record<string, { before: DraftValue; after: DraftValue }>;
        applied_now: string[];
        pending_restart: string[];
        audit_id?: string | null;
      }
    | null
  >(null);

  // Re-seed the draft from effective values whenever they appear AND the operator
  // hasn't started editing.
  useEffect(() => {
    if (settings.effective && Object.keys(draft).length === 0) {
      setDraft(settings.effective.values as Record<string, DraftValue>);
    }
  }, [settings.effective, draft]);

  const dirtyKeys = useMemo(() => {
    if (!settings.effective) return [];
    return Object.keys(draft).filter((k) => draft[k] !== settings.effective!.values[k]);
  }, [draft, settings.effective]);

  const errorByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of validationErrors) m[e.key] = e.reason;
    return m;
  }, [validationErrors]);

  const groupedSpecs = useMemo(() => {
    if (!settings.schema) return [] as Array<[string, SettingSpec[]]>;
    const by: Record<string, SettingSpec[]> = {};
    for (const s of settings.schema.settings) (by[s.category] ??= []).push(s);
    return Object.entries(by);
  }, [settings.schema]);

  async function doApply(opts: { confirmPrivacy?: boolean } = {}) {
    if (!dirtyKeys.length || !settings.effective) return;
    const diff: Record<string, DraftValue> = {};
    const beforeAfter: Record<string, { before: DraftValue; after: DraftValue }> = {};
    for (const k of dirtyKeys) {
      const v = draft[k];
      if (v !== undefined) {
        diff[k] = v;
        beforeAfter[k] = {
          before: settings.effective.values[k] as DraftValue,
          after: v,
        };
      }
    }
    // Structured console log so operators tuning from DevTools can trace
    // every apply without pulling server logs. ``console.group`` keeps
    // the whole thing collapsible; the entries survive the StrictMode
    // double-render because we only log on successful apply.
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `[settings] apply → ${Object.keys(diff).length} key(s)`,
    );
    // eslint-disable-next-line no-console
    console.table(beforeAfter);
    // eslint-disable-next-line no-console
    console.groupEnd();
    setSubmitting(true);
    setValidationErrors([]);
    setWarnings([]);
    try {
      const res: ApplyResultPayload = await settings.apply(diff, {
        confirm_privacy_change: !!opts.confirmPrivacy,
      });
      setWarnings(res.warnings || []);
      setApplyResult({
        kind: "apply",
        diff: beforeAfter,
        applied_now: res.applied_now || [],
        pending_restart: res.pending_restart || [],
        audit_id: res.audit_id ?? null,
      });
      // eslint-disable-next-line no-console
      console.info("[settings] apply ok", {
        applied_now: res.applied_now,
        pending_restart: res.pending_restart,
        audit_id: res.audit_id,
        warnings: res.warnings,
      });
      setDraft({});
      // Pull the new Impact session so the card starts showing deltas
      // without waiting for the 15 s poller.
      void impact.refresh();
    } catch (exc) {
      // eslint-disable-next-line no-console
      console.warn("[settings] apply failed", exc);
      const errors = extractValidationErrors(exc);
      if (errors) { setValidationErrors(errors); return; }
      if (isPrivacyConfirmRequired(exc)) {
        const confirmed = await dialog.confirm({
          title: "Privacy-sensitive change",
          message:
            "This change touches a privacy-sensitive setting (ALPR_MODE). " +
            "Toggling License Plate Recognition changes what data leaves the edge — confirm to proceed.",
          okLabel: "Apply with privacy change",
          variant: "warning",
        });
        if (confirmed) {
          await doApply({ confirmPrivacy: true });
        }
        return;
      }
      if (exc instanceof MissingAdminTokenError) return;
      const status = (exc as AdminApiError).status;
      if (status === 409) {
        await dialog.alert({
          title: "Settings changed elsewhere",
          message: "Another operator (or another tab) updated the settings since you opened this page. Refreshing the view now.",
          variant: "warning",
        });
        await settings.refresh();
        setDraft({});
        return;
      }
      if (status === 429) {
        await dialog.alert({
          title: "Apply rate-limited",
          message: "Too many applies in quick succession. Wait a few seconds and try again.",
          variant: "warning",
        });
        return;
      }
      console.error(exc);
      await dialog.alert({
        title: "Apply failed",
        message: (exc as Error).message,
        variant: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function doRollback() {
    const ok = await dialog.confirm({
      title: "Rollback to last-known-good",
      message:
        "Restore the snapshot that was active immediately before the most recent apply. " +
        "Subscribers (LLM bucket, track-history rebuild, etc.) will re-fire.",
      okLabel: "Rollback",
      variant: "danger",
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      const res = await settings.rollback();
      setWarnings(res.warnings || []);
      setApplyResult({
        kind: "rollback",
        diff: {},
        applied_now: res.applied_now || [],
        pending_restart: res.pending_restart || [],
        audit_id: res.audit_id ?? null,
      });
      // eslint-disable-next-line no-console
      console.info("[settings] rollback ok", {
        applied_now: res.applied_now,
        pending_restart: res.pending_restart,
      });
      setDraft({});
      await impact.refresh();
    } catch (exc) {
      await dialog.alert({
        title: "Rollback failed",
        message: (exc as Error).message,
        variant: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function doApplyTemplate(id: string) {
    setSubmitting(true);
    try {
      const res = await templates.applyTemplate(id);
      setWarnings(res.warnings || []);
      setApplyResult({
        kind: "template",
        diff: {},
        applied_now: res.applied_now || [],
        pending_restart: res.pending_restart || [],
        audit_id: res.audit_id ?? null,
      });
      // eslint-disable-next-line no-console
      console.info("[settings] template apply ok", {
        template_id: id,
        applied_now: res.applied_now,
        pending_restart: res.pending_restart,
      });
      setDraft({});
      await impact.refresh();
    } catch (exc) {
      if (isPrivacyConfirmRequired(exc)) {
        const confirmed = await dialog.confirm({
          title: "Template touches privacy setting",
          message:
            "This template changes a privacy-sensitive setting (ALPR_MODE). Confirm to proceed.",
          okLabel: "Apply template",
          variant: "warning",
        });
        if (confirmed) {
          await templates.applyTemplate(id, { confirm_privacy_change: true });
          await settings.refresh();
        }
        return;
      }
      await dialog.alert({
        title: "Apply template failed",
        message: (exc as Error).message,
        variant: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Token-prompt empty state ----
  if (!token || settings.needsToken) {
    return (
      <>
        <TopBar sourceName={sourceName} connected={connected} />
        <main className={styles.main}>
          <section className={styles.center}>
            <div className={styles.tokenWrap}>
              <h2 className={styles.pageTitle}>Settings Console</h2>
              {settings.error && <div className={styles.errorList}>{settings.error}</div>}
              <p className={styles.subtle}>
                Settings is admin-tier. Paste your <code>ROAD_ADMIN_TOKEN</code>{" "}
                (kept in <code>sessionStorage</code>, cleared on tab close).
              </p>
              <div className={styles.tokenPrompt}>
                <input
                  type="password"
                  className={styles.tokenInput}
                  placeholder="ROAD_ADMIN_TOKEN…"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && tokenInput.trim()) setToken(tokenInput.trim());
                  }}
                  autoFocus
                />
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={!tokenInput.trim()}
                  onClick={() => setToken(tokenInput.trim())}
                >
                  Save token for this session
                </button>
              </div>
            </div>
          </section>
        </main>
      </>
    );
  }

  // ---- Main page ----
  return (
    <>
      <TopBar sourceName={sourceName} connected={connected} />
      <main className={styles.main}>
        <section className={styles.center}>
          {/* Page header */}
          <div className={styles.pageHeader}>
            <div className={styles.pageTitleGroup}>
              <h1 className={styles.pageTitle}>Settings</h1>
            </div>
            <div className={styles.headerActions}>
              <span className={styles.dirtyCount}>
                {dirtyKeys.length} pending change{dirtyKeys.length === 1 ? "" : "s"}
              </span>
              <button
                className={styles.btn}
                disabled={!dirtyKeys.length}
                onClick={() => setDraft({})}
              >
                Discard
              </button>
              <button
                className={`${styles.btn} ${styles.btnDanger}`}
                disabled={submitting}
                onClick={doRollback}
              >
                Rollback to last-good
              </button>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={!dirtyKeys.length || submitting}
                onClick={() => doApply()}
              >
                {submitting ? "Applying…" : `Apply${dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}`}
              </button>
            </div>
          </div>

          {/* Validation / warnings */}
          {validationErrors.length > 0 && (
            <div className={styles.errorList}>
              {validationErrors.map((e) => (
                <div key={`${e.key}:${e.reason}`}>
                  <strong>{e.key}</strong>: {e.reason}
                </div>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className={styles.warnings}>
              {warnings.map((w) => <div key={w}>{w}</div>)}
            </div>
          )}

          {/* Load error — surfaced in the main view too, otherwise a 500 /
              network failure leaves the page stuck on "Loading settings…"
              with no indication of what went wrong. */}
          {settings.error && !settings.schema && (
            <div className={styles.errorList}>
              <div><strong>Failed to load settings.</strong> {settings.error}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  className={styles.btn}
                  onClick={() => void settings.refresh()}
                  disabled={settings.loading}
                >
                  {settings.loading ? "Retrying…" : "Retry"}
                </button>
                <button
                  className={styles.btn}
                  onClick={() => clearToken()}
                  title="Clear the cached admin token and re-prompt"
                >
                  Forget token
                </button>
              </div>
            </div>
          )}

          {/* Tunables */}
          {settings.schema && settings.effective && groupedSpecs.map(([cat, specs]) => (
            <details key={cat} className={styles.category} open>
              <summary>{humanize(cat)} <span style={{ float: "right", fontSize: 10 }}>{specs.length}</span></summary>
              <div className={styles.categoryBody}>
                {specs.map((spec) => {
                  const eff = settings.effective!.values[spec.key] as DraftValue;
                  const cur = (draft[spec.key] ?? eff) as DraftValue;
                  return (
                    <TunableControl
                      key={spec.key}
                      spec={spec}
                      effective={eff}
                      draft={cur}
                      errorReason={errorByKey[spec.key] ?? null}
                      onChange={(v) => setDraft({ ...draft, [spec.key]: v })}
                    />
                  );
                })}
              </div>
            </details>
          ))}

          {!settings.schema && !settings.error && (
            <p className={styles.subtle}>
              {settings.loading ? "Loading settings…" : "Settings not loaded yet."}
            </p>
          )}
        </section>

        <aside className={styles.right}>
          <TemplatesCard
            templates={templates.templates}
            busy={submitting}
            onApply={doApplyTemplate}
            onCreate={async (name, description) => {
              if (!settings.effective) return;
              await templates.create(name, description, settings.effective.values);
            }}
            onDelete={async (id) => templates.remove(id)}
          />
          <BaselineCard onCaptured={() => impact.refresh()} />
          <ImpactCard
            report={impact.report}
            refreshing={impact.refreshing}
            onRefresh={() => impact.refresh()}
          />

          {/* Optional video preview — collapsed by default to save space. */}
          <details className={`${styles.card} ${styles.videoCard}`}>
            <summary className={styles.cardTitle}>Live preview</summary>
            <img src="/admin/video_feed" alt="Live preview" />
            <span className={styles.subtle}>
              source: {sourceName}{live?.target_fps ? ` @ ${live.target_fps}fps` : ""}
            </span>
          </details>
        </aside>
      </main>
    </>
  );
}
