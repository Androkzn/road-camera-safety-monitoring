/**
 * FeedbackButtons — "Correct" / "False alarm" pair rendered at the bottom
 * of each EventCard. POSTs the operator's verdict to `/api/feedback`
 * (the event-scoped endpoint is `/api/events/{id}/feedback`), which
 * feeds into the drift / precision tracker (services/drift.py).
 *
 * Lives in `shared/events/` because both Dashboard and Admin event
 * surfaces reuse it.
 *
 * --- UI mapping ---
 * Used on: DashboardPage, AdminPage (and anywhere EventCard is shown).
 * UI element: a "Correct" / "False alarm" button pair at the bottom of
 *   each event card, with a "thanks" acknowledgement after submission.
 *
 * --- Backend endpoint ---
 *  POST `/api/feedback` with body `{event_id, verdict: "tp" | "fp"}`.
 *  Only the event_id + verdict are sent — no frame data, no plate text
 *  (raw plate text never reaches the FE anyway; stripped at ingest).
 */

import { useState, useCallback } from "react";

import { postJson } from "../lib/fetchClient";

import styles from "./FeedbackButtons.module.css";

interface FeedbackButtonsProps {
  eventId: string;
}

/**
 * FeedbackButtons — single-shot verdict submitter. Once `submitted` is
 * true, both buttons are disabled so the operator can't flip-flop and
 * skew the drift signal.
 *
 * Props:
 *  - eventId: the SafetyEvent.event_id to attribute the verdict to.
 *
 * UI connections: styled buttons + inline SVG icons; emits its own
 * "thanks"/"retry" acknowledgement inline — no portal, no toast system.
 *
 * Backend calls: POST /api/feedback { event_id, verdict }.
 */
export function FeedbackButtons({ eventId }: FeedbackButtonsProps) {
  // One useState holds a small state-machine object. Simpler than four
  // separate states and guarantees transitions are atomic.
  const [state, setState] = useState<{
    submitted: boolean;
    verdict: string | null;
    error: boolean;
    loading: boolean;
  }>({ submitted: false, verdict: null, error: false, loading: false });

  // `useCallback` memoises the function identity across renders —
  // matters when it's passed to child components via props.
  //
  // Submission is intentionally NOT optimistic: we flip to `loading`
  // first, wait for the POST to succeed, then commit `submitted + verdict`
  // so a network failure resets cleanly and the user can retry. Showing a
  // chosen-verdict state before the server confirms would risk logging a
  // verdict we never actually persisted.
  const submit = useCallback(
    async (verdict: "tp" | "fp") => {
      // Guard against double-clicks and post-submission clicks — once
      // committed, a verdict is final (see submitted-disables-both note).
      if (state.submitted || state.loading) return;
      setState({
        submitted: false,
        verdict: null,
        error: false,
        loading: true,
      });
      try {
        await postJson<{ status: string }>("/api/feedback", {
          event_id: eventId,
          verdict,
        });
        // Success: commit the verdict — this also disables both buttons.
        setState({ submitted: true, verdict, error: false, loading: false });
      } catch {
        // Failure: surface a small "(retry)" hint and leave both buttons
        // enabled so the operator can try again.
        setState({
          submitted: false,
          verdict: null,
          error: true,
          loading: false,
        });
      }
    },
    [eventId, state.submitted, state.loading],
  );

  return (
    <div className={styles.fb}>
      <button
        type="button"
        className={`${styles.btn} ${styles.tp} ${state.verdict === "tp" ? styles.chosen : ""} ${state.submitted && state.verdict !== "tp" ? styles.faded : ""}`}
        disabled={state.submitted || state.loading}
        onClick={() => submit("tp")}
        title="True positive"
      >
        <svg
          className={styles.ico}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 1v5h5a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7" />
        </svg>
        Correct
      </button>
      <button
        type="button"
        className={`${styles.btn} ${styles.fp} ${state.verdict === "fp" ? styles.chosen : ""} ${state.submitted && state.verdict !== "fp" ? styles.faded : ""}`}
        disabled={state.submitted || state.loading}
        onClick={() => submit("fp")}
        title="False alarm"
      >
        <svg
          className={styles.ico}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-3-1v-5H5a2 2 0 0 1-2-2l2-7a2 2 0 0 1 2-2h10" />
        </svg>
        False alarm
      </button>
      {state.submitted && <span className={`${styles.ack} ${styles.ok}`}>&#10003; thanks</span>}
      {state.error && <span className={`${styles.ack} ${styles.err}`}>(retry)</span>}
    </div>
  );
}
