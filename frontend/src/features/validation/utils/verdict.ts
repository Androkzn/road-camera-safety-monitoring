/**
 * Pure helpers for the validation EventsPanel: verdict labelling,
 * dispute-note parsing from a WatchdogFinding, plus time + object
 * formatting shared between EventsPanel (shadow-only list + dialog copy)
 * and EventRow.
 *
 * No JSX, no React imports, no side effects — strict TS.
 */
import type {
  SafetyEvent,
  WatchdogFinding,
} from "../../../shared/types/common";

export const VERIFY_GRACE_MS = 5_000;

export type Verdict = "verified" | "disputed" | "pending";

export interface DisputeInfo {
  kind: string;
  primary?: string;
  secondary?: string;
}

export interface PanelEvent {
  ev: SafetyEvent;
  verdict: Verdict;
  dispute?: DisputeInfo;
}

export function humanize(value: string | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ");
}

export function evidenceGet(
  f: WatchdogFinding,
  label: string,
): string | undefined {
  return f.evidence?.find((e) => e.label === label)?.value;
}

export function parseDispute(f: WatchdogFinding): DisputeInfo {
  const fp = f.fingerprint ?? "";
  let kind = "disagreement";
  if (fp.endsWith("false-positive")) kind = "False positive";
  else if (fp.endsWith("classification-mismatch")) kind = "Class mismatch";
  else if (fp.endsWith("false-negative")) kind = "Missed detection";
  return {
    kind,
    primary: evidenceGet(f, "primary_label") ?? evidenceGet(f, "primary_risk"),
    secondary:
      evidenceGet(f, "secondary_label") ?? evidenceGet(f, "secondary_risk"),
  };
}

export function formatTime(ts?: string): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

/**
 * Build the short verdict-badge label shown on each EventRow.
 */
export function verdictLabel(verdict: Verdict): string {
  if (verdict === "verified") return "✓ Verified";
  if (verdict === "disputed") return "⚠ Disputed";
  return "Pending";
}

/**
 * Compose the dispute detail sentence used in both the inline row
 * expansion and the EventDialog body so they stay in lockstep.
 */
export function disputeDetail(dispute: DisputeInfo): string {
  if (dispute.primary || dispute.secondary) {
    return `Primary said ${humanize(dispute.primary)} · Secondary said ${humanize(dispute.secondary)}`;
  }
  return "Secondary detector disagreed with the primary on this frame.";
}

/**
 * Assign a verdict to a primary event given the current map of
 * validator findings keyed by `primary_event_id` and whether the
 * validator is enabled.
 *
 * Pure — takes `now` explicitly so callers (and tests) stay in
 * control of the clock.
 */
export function classifyEvent(
  ev: SafetyEvent,
  disputesByEventId: Map<string, WatchdogFinding>,
  validatorEnabled: boolean,
  now: number,
): PanelEvent {
  const dispute = disputesByEventId.get(ev.event_id);
  if (dispute) {
    return { ev, verdict: "disputed", dispute: parseDispute(dispute) };
  }
  const age = ev.wall_time ? now - new Date(ev.wall_time).getTime() : 0;
  const settled = age >= VERIFY_GRACE_MS;
  return {
    ev,
    verdict: validatorEnabled && settled ? "verified" : "pending",
  };
}

/**
 * Build the { event_id → WatchdogFinding } lookup used to mark
 * disputed events. Only findings that carry a `primary_event_id`
 * evidence entry land in the map.
 */
export function buildDisputesByEventId(
  validatorFindings: WatchdogFinding[],
): Map<string, WatchdogFinding> {
  const map = new Map<string, WatchdogFinding>();
  for (const f of validatorFindings) {
    const id = evidenceGet(f, "primary_event_id");
    if (id) map.set(id, f);
  }
  return map;
}

/**
 * Format up to the first three objects in an event for the row meta
 * line (e.g. `car · pedestrian · bike`). Returns the humanized,
 * " · "-joined string, or an empty string when the event has no
 * objects.
 */
export function formatObjects(objects: string[] | undefined): string {
  return objects?.slice(0, 3).map((o) => humanize(o)).join(" · ") ?? "";
}

/**
 * Format confidence as a percentage string, or em-dash when missing.
 */
export function formatConfidencePct(confidence: number | undefined): string {
  return typeof confidence === "number"
    ? `${Math.round(confidence * 100)}%`
    : "—";
}
