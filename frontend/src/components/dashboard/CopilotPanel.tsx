/**
 * CopilotPanel — the LLM chat widget on the dashboard.
 *
 * Rendered by: pages/DashboardPage.tsx. Sits alongside the KPI tiles and
 * perception banners. All chat state lives in a custom hook.
 *
 * Props: none. This component is self-contained — it reads its state from
 * the `useChat` hook, which owns the message list, loading flag, and the
 * `send` function that POSTs to `/api/copilot` (see hooks/useChat.ts).
 *
 * React concepts first-taught in this file:
 *   - Custom hooks: `useChat()` — encapsulated state + effects reusable
 *     across components. Hooks must be called at the top of a component
 *     body, never inside conditions or loops ("Rules of Hooks").
 *   - `useRef` for imperative DOM access (scroll container, textarea value).
 *     Refs do *not* cause re-renders when their `.current` changes.
 *   - `useEffect(fn, deps)` — run side-effects after render. The `deps`
 *     array ([messages]) means "re-run when messages changes".
 *   - Why this textarea is "uncontrolled" (value read from ref on submit)
 *     vs a typical "controlled" input that lives in useState. Both patterns
 *     are valid; controlled is more common but uncontrolled avoids a
 *     re-render on every keystroke.
 *   - Form submission: onSubmit + preventDefault to stop browser page
 *     reload. Enter-to-send vs Shift+Enter-for-newline keybinding.
 *   - `.map(...)` to render a list, and the required `key` prop.
 *   - Inline arrow handlers (`onClick={() => handleChipClick(...)}`)
 *     when you need to pre-bind arguments.
 *   - Typed DOM events: `FormEvent`, `KeyboardEvent<HTMLTextAreaElement>`.
 */

// --- Imports ---
// TEACH: Hook imports from React. `useRef` / `useEffect` are *hook APIs*;
// they can only be called from inside a functional component (or another
// custom hook). `type FormEvent, type KeyboardEvent` are type-only imports
// stripped at build time — they're just for TypeScript.
import { useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
// TEACH: A *custom hook*. Convention: name starts with `use`. Internally it
// probably calls `useState` and `fetch`. We treat its return value as an
// opaque bundle of state + actions.
import { useChat } from "../../hooks/useChat";
import styles from "./CopilotPanel.module.css";

// --- Constants ---
// TEACH: Defined at module scope (outside the component) so the array is
// created once at module load, not re-allocated on every render. Cheap but
// a good habit for anything constant.
const CHIPS = [
  { label: "Any high-risk pedestrian events?", query: "Any high-risk pedestrian events in the last 2 minutes?" },
  { label: "Medium-risk SLA?", query: "What's our SLA for medium-risk events?" },
  { label: "Summarize last 10 events", query: "Summarize the last 10 events." },
];

// --- Render ---
export function CopilotPanel() {
  // --- State ---
  // TEACH: Custom-hook call. `messages` is a list of chat turns, `loading`
  // is the in-flight flag, `send(text)` fires the request. All the React
  // state lives inside useChat — this component just consumes it.
  const { messages, loading, send } = useChat();

  // TEACH: `useRef<T>(initial)` returns a stable `{ current: T | null }`
  // object. The DOM element attaches itself when we do `ref={chatRef}`
  // on a JSX element. Mutating `chatRef.current` does NOT trigger a
  // re-render — that's the whole point of useRef vs useState.
  const chatRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // --- Effects ---
  // TEACH: `useEffect(fn, deps)` runs `fn` after the DOM has been painted,
  // whenever any entry in `deps` has changed by reference since the last
  // render. Here: auto-scroll the chat to the bottom whenever a new message
  // arrives. If we used `[]` the effect would fire once on mount; with no
  // array it would fire after every render. `[messages]` is the sweet spot.
  //
  // Note: no cleanup function returned. For effects that subscribe to
  // something (SSE, timers), you'd `return () => unsubscribe()` — React
  // calls the cleanup before re-running the effect and on unmount.
  useEffect(() => {
    chatRef.current?.scrollTo(0, chatRef.current.scrollHeight);
  }, [messages]);

  // --- Handlers ---
  // TEACH: Form submit handler. `FormEvent` is the typed React event. We
  // MUST `preventDefault()` — otherwise the browser does a full page
  // reload when the form submits (SPA-killer).
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // TEACH: "Uncontrolled" input pattern — we peek at the DOM value on
    // submit via the ref, instead of mirroring every keystroke into state.
    // This trades "React as source of truth" for fewer re-renders. It's
    // a conscious choice here because the textarea value is only read at
    // submit time, not rendered elsewhere.
    const q = textareaRef.current?.value ?? "";
    if (q.trim()) {
      send(q);
      if (textareaRef.current) textareaRef.current.value = "";
    }
  };

  // TEACH: Enter-to-send / Shift+Enter-for-newline keybinding. We cast the
  // KeyboardEvent to FormEvent to reuse handleSubmit — fine because
  // handleSubmit only uses `preventDefault()` which exists on both.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  };

  // TEACH: Chip click prefills the textarea via the ref (imperative DOM
  // access) and focuses it, letting the user tweak the query before send.
  const handleChipClick = (query: string) => {
    if (textareaRef.current) {
      textareaRef.current.value = query;
      textareaRef.current.focus();
    }
  };

  return (
    <section className={styles.panel}>
      {/* Header block */}
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>
            Copilot <span className={styles.sub}>RAG over statutes + live events</span>
          </h2>
        </div>
      </div>

      {/* Chat transcript.
          TEACH: `ref={chatRef}` wires this div to our ref so useEffect
          can scroll it. */}
      <div className={styles.chat} ref={chatRef}>
        {/* TEACH: Rendering a list with `.map`. React needs a stable `key`
            on each element so it can reconcile the list efficiently across
            re-renders. `msg.id` (a stable server-assigned id) is perfect.
            NEVER use array index as key if the list can reorder. */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            // TEACH: Dynamic class composition — role ("user"/"assistant")
            // drives which CSS-module class applies, plus an optional
            // error class.
            className={`${styles.msg} ${styles[msg.role]} ${msg.isError ? styles.err : ""}`}
          >
            {msg.text}
          </div>
        ))}
      </div>

      {/* Suggestion chips row */}
      <div className={styles.chips}>
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            className={styles.chip}
            // TEACH: `type="button"` prevents it from submitting the parent
            // form — default <button> inside a <form> is type="submit".
            type="button"
            // TEACH: Inline arrow so we can pre-bind `chip.query`. A new
            // function is allocated per render; harmless for small lists
            // like this one. For heavy/memoized children you'd useCallback.
            onClick={() => handleChipClick(chip.query)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Compose form — the textarea + send button. */}
      <form className={styles.compose} onSubmit={handleSubmit} autoComplete="off">
        <textarea
          ref={textareaRef}
          placeholder="Ask Copilot… (Enter to send, Shift+Enter = newline)"
          onKeyDown={handleKeyDown}
        />
        {/* TEACH: `disabled={loading}` is conditional UI — when a request is
            in flight, the button grays out and the label changes. This is
            "derived UI from state" — the whole React mental model. */}
        <button type="submit" disabled={loading}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
