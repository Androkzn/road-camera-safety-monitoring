/**
 * FeedbackButtons.tsx — "Correct" / "False alarm" buttons for an event.
 *
 * What it does:
 *   Shows two buttons (thumbs-up "Correct" and thumbs-down "False alarm").
 *   Clicking one POSTs the operator's verdict, disables both buttons, and
 *   fades out the non-chosen button. Shows a small "thanks" acknowledgment
 *   on success or "(retry)" on error.
 *
 * Purpose:
 *   Captures labelled feedback that the backend uses to compute precision
 *   drift over time (see the Drift banner on the Dashboard).
 *
 * How it works:
 *   - Props: `eventId` — the id of the event this feedback is for.
 *   - `useState` holds one object with four fields: `submitted`, `verdict`,
 *     `error`, `loading`. Using an object means one setter updates them
 *     together atomically.
 *   - `useCallback(fn, deps)` memoizes `submit` so its identity only
 *     changes when a dep changes — helpful so the handler isn't recreated
 *     on every render.
 *   - `submit` early-returns if already submitted or in-flight, then awaits
 *     `api.sendFeedback(eventId, verdict)` inside a try/catch to distinguish
 *     success from failure states.
 *   - Union type `verdict: "tp" | "fp"` limits the argument to those two
 *     exact strings.
 *
 * Connects to:
 *   - Backend: `POST /api/feedback { event_id, verdict }`.
 *   - UI: rendered at the bottom of every `<EventCard>` on the Dashboard.
 */
// useState: holds component-local state that triggers re-render on change.
// useCallback: memoizes a function so its identity stays stable across renders.
import { useState, useCallback } from "react";
// api.sendFeedback — wraps POST /api/feedback (see ../../lib/api.ts).
import { api } from "../../lib/api";
import styles from "./FeedbackButtons.module.css";

// Props contract: which event this button pair belongs to.
interface FeedbackButtonsProps {
  eventId: string;
}

// FeedbackButtons — the two thumbs buttons shown at the bottom of every
// EventCard on the Dashboard. One click sends the operator's verdict to the
// backend and locks the row.
export function FeedbackButtons({ eventId }: FeedbackButtonsProps) {
  // `state` — single object tracking: was the click submitted? which verdict?
  // did the request error? is it currently in-flight? One setter updates all
  // four atomically so the UI never shows an inconsistent combo.
  const [state, setState] = useState<{
    submitted: boolean;
    verdict: string | null;
    error: boolean;
    loading: boolean;
  }>({ submitted: false, verdict: null, error: false, loading: false });

  // submit — click handler for both buttons. `async`/`await` pauses the function
  // until the promise resolves without blocking the rest of the UI.
  // The verdict param is a union type: only "tp" (true positive) or "fp" allowed.
  // useCallback re-creates this function only when one of the deps changes.
  const submit = useCallback(
    async (verdict: "tp" | "fp") => {
      // Guard: ignore double-clicks or clicks while a request is already flying.
      if (state.submitted || state.loading) return;
      // Enter loading state: disables both buttons via `disabled` below.
      setState({ submitted: false, verdict: null, error: false, loading: true });
      // try/catch: run the try block; if the network call throws, catch runs instead.
      try {
        await api.sendFeedback(eventId, verdict);
        // Success: lock the row, record which verdict was chosen, show the tick.
        setState({ submitted: true, verdict, error: false, loading: false });
      } catch {
        // Failure: unlock so the user can retry, show the "(retry)" hint.
        setState({ submitted: false, verdict: null, error: true, loading: false });
      }
    },
    [eventId, state.submitted, state.loading],
  );

  return (
    // {/* Two-button row: "Correct" (thumbs up) and "False alarm" (thumbs down) */}
    <div className={styles.fb}>
      {/* Thumbs-up "Correct" button. Gets `chosen` when clicked, `faded` when the other one was chosen. */}
      <button
        type="button"
        className={`${styles.btn} ${styles.tp} ${state.verdict === "tp" ? styles.chosen : ""} ${state.submitted && state.verdict !== "tp" ? styles.faded : ""}`}
        disabled={state.submitted || state.loading}
        onClick={() => submit("tp")}
        title="True positive"
      >
        {/* Inline thumbs-up icon (SVG path) */}
        <svg className={styles.ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 1v5h5a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7" />
        </svg>
        Correct
      </button>
      {/* Thumbs-down "False alarm" button — mirror of the Correct button. */}
      <button
        type="button"
        className={`${styles.btn} ${styles.fp} ${state.verdict === "fp" ? styles.chosen : ""} ${state.submitted && state.verdict !== "fp" ? styles.faded : ""}`}
        disabled={state.submitted || state.loading}
        onClick={() => submit("fp")}
        title="False alarm"
      >
        {/* Inline thumbs-down icon (SVG path) */}
        <svg className={styles.ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-3-1v-5H5a2 2 0 0 1-2-2l2-7a2 2 0 0 1 2-2h10" />
        </svg>
        False alarm
      </button>
      {/* Success acknowledgment — the little green tick + "thanks" that appears after submit */}
      {state.submitted && (
        <span className={`${styles.ack} ${styles.ok}`}>&#10003; thanks</span>
      )}
      {/* Error hint — "(retry)" label after a failed POST */}
      {state.error && (
        <span className={`${styles.ack} ${styles.err}`}>(retry)</span>
      )}
    </div>
  );
}
