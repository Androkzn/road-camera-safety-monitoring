/**
 * Settings-specific display helpers.
 *
 * Numeric formatting, key humanization, label lookups, source shortening,
 * tier-class picker. Pure functions — no React, no network.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: No direct UI — helpers used by the SettingsPage components
 *   to format numbers, labels and confidence tier styles.
 * Consumers: tunable rows, impact card, and any feature-local table
 *   inside `features/settings/` that renders tunable metadata.
 * Backend: none — display layer only.
 */
import {
  METRIC_LABELS,
  REASON_LABELS,
  SEVERITY_LABELS,
  TOKEN_REWRITES,
  UNIT_TOKENS,
} from "../constants";
import type { ConfidenceTier } from "../types";

import settingsStyles from "../SettingsPage.module.css";

/**
 * Format a number for display with fixed decimals.
 *
 * - `v`      — value; `null` / `undefined` / non-finite (NaN, Infinity)
 *   collapse to the em-dash placeholder "—".
 * - `digits` — decimal places, default 2.
 *
 * Never throws. Pure.
 */
export function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v).toFixed(digits);
}

/**
 * Map a {@link ConfidenceTier} onto the matching CSS-module class.
 *
 * Returns an empty string if the CSS-module lookup misses (defensive: the
 * class may legitimately be absent during Jest-style tests without CSS).
 * The `default` branch covers the "insufficient" tier and any unexpected
 * string that slipped past the type.
 */
export function tierClass(tier: ConfidenceTier): string {
  switch (tier) {
    case "high":
      return settingsStyles.tierHigh ?? "";
    case "medium":
      return settingsStyles.tierMedium ?? "";
    case "low":
      return settingsStyles.tierLow ?? "";
    default:
      return settingsStyles.tierInsufficient ?? "";
  }
}

/**
 * Pull a human unit off the tail of a humanized token list.
 *
 * Returns `{ unit, consume }` where `consume` is the number of trailing
 * tokens that were absorbed into the unit (so the caller can strip them
 * before joining the remaining tokens into the label).
 * Internal helper — not exported.
 */
function unitFromTail(tokens: string[]): {
  unit: string | null;
  consume: number;
} {
  if (tokens.length === 0) return { unit: null, consume: 0 };
  const last = (tokens[tokens.length - 1] ?? "").toUpperCase();
  // "…_PER_MIN" / "…_PER_SEC" / "…_PER_HOUR" — two-token suffix.
  if (tokens.length >= 2 && (tokens[tokens.length - 2] ?? "").toUpperCase() === "PER") {
    if (last === "MIN") return { unit: "per minute", consume: 2 };
    if (last === "SEC") return { unit: "per second", consume: 2 };
    if (last === "HOUR") return { unit: "per hour", consume: 2 };
  }
  // Single-token unit lookup (e.g. "…_MS" → "ms").
  if (UNIT_TOKENS[last]) return { unit: UNIT_TOKENS[last]!, consume: 1 };
  return { unit: null, consume: 0 };
}

/**
 * Humanize a single snake/kebab token, applying known rewrites first
 * (e.g. "TTC" → "TTC", "URL" → "URL") and falling back to Title Case.
 * `Pxx` tokens (e.g. "P95") are preserved as lowercase percentile labels.
 * Internal helper — not exported.
 */
function humanizeToken(word: string): string {
  const upper = word.toUpperCase();
  if (TOKEN_REWRITES[upper] !== undefined) return TOKEN_REWRITES[upper];
  if (/^P\d+$/.test(upper)) return upper.toLowerCase();
  const lower = word.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Turn a machine key ("MIN_TTC_SEC", "max-events-per-min") into a
 * human label ("Min TTC, per second", "Max Events, per minute").
 *
 * Splits on `_`, `-`, and whitespace; appends a ", <unit>" suffix when
 * the tail matches a known unit pattern (see {@link unitFromTail}).
 */
export function humanize(raw: string): string {
  const tokens = raw.split(/[_\-\s]+/).filter(Boolean);
  const { unit, consume } = unitFromTail(tokens);
  // Strip trailing unit tokens so they don't also appear in the head label.
  const head = consume > 0 ? tokens.slice(0, tokens.length - consume) : tokens;
  const headLabel = head.map(humanizeToken).join(" ");
  return unit ? `${headLabel}, ${unit}` : headLabel;
}

/**
 * Render an operator-session state string.
 *
 * Special-cases the compound "monitoring_unattended" (which would
 * otherwise humanize as "Monitoring Unattended") so the UI shows a
 * clearer "Monitoring (unattended)" badge. All other states fall
 * through to {@link humanize}.
 */
export function formatState(state: string): string {
  if (state === "monitoring_unattended") return "Monitoring (unattended)";
  return humanize(state);
}

/**
 * Lookup-with-fallback helpers: each returns a curated label from the
 * constants tables ({@link METRIC_LABELS}, {@link REASON_LABELS},
 * {@link SEVERITY_LABELS}) and falls back to {@link humanize} so that
 * newly-added backend keys still render as something readable before
 * the FE is updated.
 */
export function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? humanize(key);
}

export function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? humanize(key);
}

export function severityLabel(key: string): string {
  return SEVERITY_LABELS[key] ?? humanize(key);
}

/**
 * Compact a stream source string for tight table cells.
 *
 * - Empty → em-dash.
 * - YouTube links → literal `"youtube"` (all youtu.be / youtube.com
 *   URLs collapse to one label).
 * - Other HTTP URLs → hostname without leading "www.", or the first
 *   24 chars if URL parsing throws (bad input).
 * - Local paths / identifiers → last non-empty segment after `/`.
 */
export function shortSource(src: string): string {
  if (!src) return "—";
  if (/youtube\.com|youtu\.be/.test(src)) return "youtube";
  if (src.startsWith("http")) {
    try {
      return new URL(src).hostname.replace(/^www\./, "");
    } catch {
      // Malformed URL — bail to a truncated preview rather than throwing.
      return src.slice(0, 24);
    }
  }
  const seg = src.split("/").filter(Boolean).pop();
  return seg || src;
}
