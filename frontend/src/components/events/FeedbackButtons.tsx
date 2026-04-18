/**
 * FeedbackButtons — "Correct" / "False alarm" pair rendered at the bottom of
 * each EventCard. Lets the viewer flag whether the detection was a true
 * positive (tp) or false positive (fp).
 *
 * Rendered by: EventCard.tsx (see ./EventCard.tsx).
 * Network:     POSTs to /api/feedback via `api.sendFeedback()` from
 *              frontend/src/lib/api.ts.
 * Server:      The backend feeds these verdicts into the drift / precision
 *              tracker in road_safety/services/drift.py.
 *
 * React concepts first taught here:
 *   - Functional component with a typed Props interface.
 *   - `useState` with a richer object-shaped state (submitted/verdict/error/
 *     loading) instead of multiple separate useState hooks.
 *   - `useCallback` — memoizing an event handler so its identity is stable
 *     across renders (matters when it's passed as a prop or used in a
 *     dependency array).
 *   - async/await inside a React handler, with try/catch for error UX.
 *   - Composing multiple className strings via template literals.
 *   - Disabling buttons while a request is in flight.
 *   - Conditional rendering with `{state.submitted && (...)}`.
 */

import { useState, useCallback } from "react";
import { api } from "../../lib/api";
import styles from "./FeedbackButtons.module.css";
// TEACH: `import styles from "./X.module.css"` uses Vite's CSS Modules support.
// `styles` is an object whose keys are the class names defined in the CSS file,
// and whose values are uniquely-hashed class names (e.g. `FeedbackButtons_btn__a1b2c3`).
// This is how we get component-scoped styles without BEM or CSS-in-JS.

// --- Types ---

// TEACH: A `Props` interface documents exactly what the parent must pass.
// TypeScript will error at the call site if `eventId` is missing or the wrong type.
interface FeedbackButtonsProps {
  eventId: string;
}

// TEACH: Functional component = a plain function that returns JSX.
// The `{ eventId }` destructures the single props object so we can use
// `eventId` directly in the body, rather than writing `props.eventId`.
export function FeedbackButtons({ eventId }: FeedbackButtonsProps) {
  // --- State ---

  // TEACH: `useState<T>(initial)` returns a [value, setter] pair.
  // React re-renders the component whenever the setter is called with a new value.
  // Here we group 4 related flags into one state object so a single `setState`
  // call keeps them consistent (you can never e.g. be both `loading` and `submitted`).
  const [state, setState] = useState<{
    submitted: boolean;
    verdict: string | null;
    error: boolean;
    loading: boolean;
  }>({ submitted: false, verdict: null, error: false, loading: false });

  // --- Handlers ---

  // TEACH: `useCallback(fn, deps)` memoizes a function so its reference only
  // changes when one of the deps changes. Without it, each render creates a
  // brand-new function, which can break child memoization or cause extra
  // effect re-runs. The deps list must include every value from the
  // component scope that the function reads.
  const submit = useCallback(
    async (verdict: "tp" | "fp") => {
      // Guard: ignore clicks after the user already submitted or while a
      // request is still in flight. Keeps us from double-POSTing.
      if (state.submitted || state.loading) return;
      setState({ submitted: false, verdict: null, error: false, loading: true });
      try {
        // TEACH: `await` pauses this async function until the promise resolves.
        // Note React does not await for us — it just sees state updates as
        // they happen, and re-renders accordingly.
        await api.sendFeedback(eventId, verdict);
        setState({ submitted: true, verdict, error: false, loading: false });
      } catch {
        setState({ submitted: false, verdict: null, error: true, loading: false });
      }
    },
    // TEACH: Dep array — change any of these and React creates a fresh `submit`.
    [eventId, state.submitted, state.loading],
  );

  // --- Render ---

  return (
    <div className={styles.fb}>
      {/* True-positive button. */}
      {/* TEACH: Template literals let us compose multiple class names conditionally.
          The empty string fallback keeps the space-separated list valid when a
          modifier class shouldn't apply. */}
      <button
        type="button"
        className={`${styles.btn} ${styles.tp} ${state.verdict === "tp" ? styles.chosen : ""} ${state.submitted && state.verdict !== "tp" ? styles.faded : ""}`}
        // TEACH: `disabled` here is a controlled boolean driven by state. After
        // a successful submit or while loading, the button is unclickable.
        disabled={state.submitted || state.loading}
        // TEACH: `onClick={() => submit("tp")}` — we wrap `submit` in an arrow
        // so we can pass an argument. Writing `onClick={submit("tp")}` would
        // CALL submit during render, which is almost never what you want.
        onClick={() => submit("tp")}
        title="True positive"
      >
        <svg className={styles.ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 1v5h5a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7" />
        </svg>
        Correct
      </button>
      {/* False-positive button, mirror of the above. */}
      <button
        type="button"
        className={`${styles.btn} ${styles.fp} ${state.verdict === "fp" ? styles.chosen : ""} ${state.submitted && state.verdict !== "fp" ? styles.faded : ""}`}
        disabled={state.submitted || state.loading}
        onClick={() => submit("fp")}
        title="False alarm"
      >
        <svg className={styles.ico} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-3-1v-5H5a2 2 0 0 1-2-2l2-7a2 2 0 0 1 2-2h10" />
        </svg>
        False alarm
      </button>
      {/* Conditional acknowledgement row. */}
      {/* TEACH: `{cond && <Element/>}` is the idiomatic short-circuit render.
          When `cond` is false, React simply renders nothing for that slot. */}
      {state.submitted && (
        <span className={`${styles.ack} ${styles.ok}`}>&#10003; thanks</span>
      )}
      {state.error && (
        <span className={`${styles.ack} ${styles.err}`}>(retry)</span>
      )}
    </div>
  );
}
