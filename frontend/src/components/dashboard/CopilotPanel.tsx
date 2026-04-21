/**
 * CopilotPanel.tsx — chat interface for the safety Copilot (RAG assistant).
 *
 * What it does:
 *   Renders a chat transcript, three "suggestion chips" that prefill the
 *   text box, and a compose row with a multi-line textarea plus Ask button.
 *   Pressing Enter sends, Shift+Enter inserts a newline. Auto-scrolls the
 *   transcript to the bottom when new messages arrive.
 *
 * Purpose:
 *   Gives the operator a natural-language way to query statutes and recent
 *   events ("any high-risk pedestrian events in the last 2 minutes?").
 *
 * How it works:
 *   - `useChat()` is a custom hook that owns `messages`, a `loading` flag,
 *     and a `send(query)` function that posts to the backend and appends
 *     both the user message and the reply to `messages`.
 *   - `useRef` gives a stable reference to a DOM element. `chatRef` points
 *     at the transcript div (for auto-scroll); `textareaRef` points at the
 *     textarea (for reading / clearing its value without re-rendering).
 *   - `useEffect(..., [messages])` runs after every render where `messages`
 *     changed — here it scrolls the transcript to the bottom.
 *   - `messages.map((msg) => <div key={msg.id}>…)` loops the transcript.
 *     The `key` lets React efficiently update the list when new messages
 *     append.
 *   - Conditional rendering (`msg.isError ? styles.err : ""`) picks a CSS
 *     class based on a flag.
 *
 * Connects to:
 *   - Backend: via `useChat` hook → `POST /chat { query }` returns
 *     `{ answer }` which is appended to the transcript.
 *   - UI: rendered by `pages/DashboardPage.tsx` as the right-hand column
 *     of the two-column main layout.
 */
import { useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
import { useChat } from "../../hooks/useChat";
import styles from "./CopilotPanel.module.css";

// Static list of suggestion chips shown above the compose box.
// Each chip: on-screen button label + the full query it prefills.
const CHIPS = [
  { label: "Any high-risk pedestrian events?", query: "Any high-risk pedestrian events in the last 2 minutes?" },
  { label: "Medium-risk SLA?", query: "What's our SLA for medium-risk events?" },
  { label: "Summarize last 10 events", query: "Summarize the last 10 events." },
];

// Renders the Copilot chat panel — the right-hand column of the Dashboard
// page main layout. Contains the chat transcript, three suggestion chips,
// and a compose row (textarea + Ask button) at the bottom.
export function CopilotPanel() {
  // useChat hook owns the transcript, in-flight flag, and the send() function that posts /chat.
  const { messages, loading, send } = useChat();
  // useRef = "a mutable box that survives re-renders without causing one".
  // `chatRef` points at the scrollable transcript div so we can auto-scroll it.
  const chatRef = useRef<HTMLDivElement>(null);
  // `textareaRef` points at the compose textarea so we can read/clear its value
  // without turning it into a controlled React state field.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // useEffect = "run a side-effect after render". The `[messages]` dep array
  // means this re-runs whenever the message list changes — here to scroll the
  // transcript to the bottom so the newest message is visible.
  useEffect(() => {
    chatRef.current?.scrollTo(0, chatRef.current.scrollHeight);
  }, [messages]);

  // Handles the form submit (click "Ask" or press Enter): reads the textarea,
  // sends the query if it has non-whitespace content, then clears the box.
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = textareaRef.current?.value ?? "";
    if (q.trim()) {
      send(q);
      if (textareaRef.current) textareaRef.current.value = "";
    }
  };

  // Enter submits; Shift+Enter adds a newline (default textarea behavior).
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  };

  // Clicking a suggestion chip: prefill the textarea with the chip's query and focus it.
  const handleChipClick = (query: string) => {
    if (textareaRef.current) {
      textareaRef.current.value = query;
      textareaRef.current.focus();
    }
  };

  return (
    // Outer <section> wrapping the whole Copilot panel
    <section className={styles.panel}>
      {/* Header bar: "Copilot" title + subtitle */}
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>
            Copilot <span className={styles.sub}>RAG over statutes + live events</span>
          </h2>
        </div>
      </div>

      {/* Scrollable chat transcript; auto-scrolled to bottom by the useEffect above */}
      <div className={styles.chat} ref={chatRef}>
        {/* One <div> per message; `key={msg.id}` gives React a stable identity per row.
            CSS classes chain: base, role ("user"/"assistant"), and optional error style. */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`${styles.msg} ${styles[msg.role]} ${msg.isError ? styles.err : ""}`}
          >
            {msg.text}
          </div>
        ))}
      </div>

      {/* Row of suggestion chips above the compose box — clicking prefills the textarea */}
      <div className={styles.chips}>
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            className={styles.chip}
            type="button"
            onClick={() => handleChipClick(chip.query)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Compose form at the bottom — textarea + "Ask" submit button */}
      <form className={styles.compose} onSubmit={handleSubmit} autoComplete="off">
        {/* Multi-line input; Enter sends, Shift+Enter inserts a newline */}
        <textarea
          ref={textareaRef}
          placeholder="Ask Copilot… (Enter to send, Shift+Enter = newline)"
          onKeyDown={handleKeyDown}
        />
        {/* Submit button; disabled + relabelled "Thinking…" while a request is in flight */}
        <button type="submit" disabled={loading}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
