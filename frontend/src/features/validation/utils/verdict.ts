/**
 * Pure helpers for the validation EventsPanel: verdict labelling,
 * dispute-note parsing from a WatchdogFinding, plus time + object
 * formatting shared between EventsPanel (shadow-only list + dialog copy)
 * and EventRow.
 *
 * No JSX, no React imports, no side effects — strict TS. Keeping these
 * as plain functions (not hooks) makes them trivially unit-testable.
 *
 * --- UI mapping ---
 * Page: ValidationPage ([file](frontend/src/features/validation/ValidationPage.tsx))
 * UI element: No direct UI — helper for verdict logic on ValidationPage
 *   (used by EventsPanel and EventRow to label events Pending / Verified /
 *   Disputed).
 */
import type { SafetyEvent, WatchdogFinding } from "../../../shared/types/common";

/**
 * Grace window (ms) — how long we wait for the validator to weigh in
 * before flipping an event from "Pending" to "Verified". 5s matches
 * the typical validator job latency under load.
 */
export const VERIFY_GRACE_MS = 5_000;

/**
 * `Verdict` is a TypeScript "string literal union": the type is
 * exactly one of these three strings. The compiler will reject any
 * other value. Cheaper and tighter than an enum for this case.
 */
export type Verdict = "verified" | "disputed" | "pending";

/**
 * Parsed contents of a validator WatchdogFinding — what kind of
 * disagreement it is, plus the two labels to display.
 */
export interface DisputeInfo {
  kind: string;
  primary?: string;
  secondary?: string;
}

/**
 * A SafetyEvent annotated with the UI's verdict decision. `dispute` is
 * populated only when `verdict === "disputed"`.
 */
export interface PanelEvent {
  ev: SafetyEvent;
  verdict: Verdict;
  dispute?: DisputeInfo;
}

/**
 * Turn snake_case backend identifiers into space-separated words for UI.
 * Returns an em-dash for missing values so the UI never shows "undefined".
 */
export function humanize(value: string | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ");
}

/**
 * Look up a named evidence field from a watchdog finding. Returns
 * `undefined` when the finding lacks evidence or that label isn't present.
 */
export function evidenceGet(f: WatchdogFinding, label: string): string | undefined {
  return f.evidence?.find((e) => e.label === label)?.value;
}

/**
 * Extract a {@link DisputeInfo} from a validator-category finding.
 * The dispute kind is encoded in the finding's fingerprint suffix.
 */
export function parseDispute(f: WatchdogFinding): DisputeInfo {
  const fp = f.fingerprint ?? "";
  let kind = "disagreement";
  if (fp.endsWith("false-positive")) kind = "False positive";
  else if (fp.endsWith("classification-mismatch")) kind = "Class mismatch";
  else if (fp.endsWith("false-negative")) kind = "Missed detection";
  return {
    kind,
    primary: evidenceGet(f, "primary_label") ?? evidenceGet(f, "primary_risk"),
    secondary: evidenceGet(f, "secondary_label") ?? evidenceGet(f, "secondary_risk"),
  };
}

/**
 * Render an ISO timestamp as HH:MM:SS in the browser's locale. Falls
 * back to the raw string if parsing throws (malformed input).
 */
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
  return (
    objects
      ?.slice(0, 3)
      .map((o) => humanize(o))
      .join(" · ") ?? ""
  );
}

/**
 * Format confidence as a percentage string, or em-dash when missing.
 */
export function formatConfidencePct(confidence: number | undefined): string {
  return typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : "—";
}
