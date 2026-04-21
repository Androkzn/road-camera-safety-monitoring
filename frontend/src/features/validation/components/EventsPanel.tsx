/**
 * EventsPanel — primary detection feed + shadow-only validator findings.
 *
 * Correlates each primary event with validator findings by scanning
 * the finding evidence arrays for `primary_event_id`:
 *   - finding with matching id      → "Disputed" (validator disagreed)
 *   - validator enabled + no finding for events older than grace window
 *                                   → "Verified"
 *   - otherwise                     → "Pending" (validator hasn't checked yet or is off)
 *
 * The "Clear all events" action lives on the Dashboard, not here — this
 * panel is purely informational on the Validation tab.
 *
 * Per-row rendering lives in EventRow; verdict classification and
 * dispute-note parsing live in utils/verdict.ts. This file only owns
 * the list controls + dialog wiring.
 *
 * --- UI mapping ---
 * Page: ValidationPage ([file](frontend/src/features/validation/ValidationPage.tsx))
 * UI element: the panel listing events to validate, with one row per
 *   event and a dialog when a row is opened.
 */
// `useState` — stores component-local state that survives re-renders.
// `useMemo` — memoizes a derived value; recomputes only on dep changes.
import { useMemo, useState } from "react";

import { EventDialog } from "../../../shared/events";
import type { SafetyEvent, WatchdogFinding } from "../../../shared/types/common";
import {
  buildDisputesByEventId,
  classifyEvent,
  disputeDetail,
  formatTime,
  type DisputeInfo,
  type PanelEvent,
} from "../utils/verdict";

import { EventRow } from "./EventRow";
import styles from "./EventsPanel.module.css";

/**
 * Props for {@link EventsPanel} — the three inputs needed to render both
 * the primary event list and the shadow-only list.
 */
interface EventsPanelProps {
  events: SafetyEvent[];
  findings: WatchdogFinding[];
  validatorEnabled: boolean;
}

/**
 * Render the two-section validation feed: verdict-annotated events on top,
 * shadow-only (primary-missed) findings below, plus the detail dialog.
 */
export function EventsPanel({ events, findings, validatorEnabled }: EventsPanelProps) {
  // `useState<T>` is a TS generic — `T` is the state's type. Returns a tuple
  // `[value, setter]`. `| null` is a union type: value is either the object
  // shape or null. `null` means "no dialog open".
  const [openEvent, setOpenEvent] = useState<{
    ev: SafetyEvent;
    dispute?: DisputeInfo;
  } | null>(null);
  // Simple boolean toggle for the "show low-risk events" checkbox.
  const [showLow, setShowLow] = useState(false);

  // Filter out low-risk noise unless the operator opts in.
  const visibleEvents = useMemo(
    () => (showLow ? events : events.filter((ev) => ev.risk_level !== "low")),
    [events, showLow],
  );
  const hiddenLowCount = events.length - visibleEvents.length;

  // Narrow watchdog findings to only the validator's output.
  const validatorFindings = useMemo(
    () => findings.filter((f) => f.category === "validator"),
    [findings],
  );

  // Build a Map<event_id → finding> once per findings change for O(1) lookup.
  const disputesByEventId = useMemo(
    () => buildDisputesByEventId(validatorFindings),
    [validatorFindings],
  );

  // Tag each visible event with a verdict (verified/disputed/pending).
  // `: PanelEvent[]` is an explicit type annotation on the const.
  const panelEvents: PanelEvent[] = useMemo(() => {
    const now = Date.now();
    return visibleEvents.map((ev) => classifyEvent(ev, disputesByEventId, validatorEnabled, now));
  }, [visibleEvents, disputesByEventId, validatorEnabled]);

  // Shadow-only = validator flagged something the primary missed.
  const shadowOnly = useMemo(
    () => validatorFindings.filter((f) => (f.fingerprint ?? "").endsWith("false-negative")),
    [validatorFindings],
  );

  return (
    <div className={styles.wrap}>
      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <div className={styles.titleBlock}>
            <h2>Detection events</h2>
            <p>
              Live events from the primary detector. Each row shows the validator's verdict —
              verified, disputed, or pending. Disputed rows expand with the secondary detector's
              reading.
            </p>
          </div>
          <label className={styles.showLow}>
            <input
              type="checkbox"
              checked={showLow}
              onChange={(e) => setShowLow(e.target.checked)}
            />
            Show low risk
            {hiddenLowCount > 0 && !showLow ? ` (${hiddenLowCount} hidden)` : ""}
          </label>
        </header>

        {/* Ternary in JSX: empty-state placeholder vs the actual list. */}
        {panelEvents.length === 0 ? (
          <div className={styles.empty}>
            No events yet — they appear here as the primary detector emits them.
          </div>
        ) : (
          <div className={styles.list}>
            {/* `.map(...)` is how lists are rendered in React. The `key`
                prop must be stable + unique per sibling so React can
                efficiently diff the DOM between renders. */}
            {panelEvents.map(({ ev, verdict, dispute }) => (
              <EventRow
                key={ev.event_id}
                ev={ev}
                verdict={verdict}
                dispute={dispute}
                onClick={() => setOpenEvent({ ev, dispute })}
              />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <div className={styles.titleBlock}>
            <h2>Shadow-only detections</h2>
            <p>
              Events the shadow validator flagged but the primary detector missed. Surface them to
              catch false negatives.
            </p>
          </div>
        </header>

        {shadowOnly.length === 0 ? (
          <div className={styles.empty}>
            {validatorEnabled
              ? "No shadow-only detections in the current window."
              : "Shadow validator is disabled — enable it above to surface misses."}
          </div>
        ) : (
          <div className={styles.list}>
            {shadowOnly.map((f) => (
              <div key={`${f.snapshot_id}_${f.ts}`} className={styles.shadowRow}>
                <div className={styles.shadowTop}>
                  <span className={styles.shadowTitle}>{f.title}</span>
                  <span className={`${styles.badge} ${styles.badgeDisputed}`}>Shadow flag</span>
                </div>
                <div className={styles.shadowMeta}>
                  {formatTime(f.ts)} · {f.detail}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <EventDialog
        event={openEvent?.ev ?? null}
        disputeLabel={openEvent?.dispute?.kind}
        disputeBody={openEvent?.dispute ? disputeDetail(openEvent.dispute) : undefined}
        onClose={() => setOpenEvent(null)}
      />
    </div>
  );
}
