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

const CHIPS = [
  { label: "Any high-risk pedestrian events?", query: "Any high-risk pedestrian events in the last 2 minutes?" },
  { label: "Medium-risk SLA?", query: "What's our SLA for medium-risk events?" },
  { label: "Summarize last 10 events", query: "Summarize the last 10 events." },
];

export function CopilotPanel() {
  const { messages, loading, send } = useChat();
  const chatRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatRef.current?.scrollTo(0, chatRef.current.scrollHeight);
  }, [messages]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = textareaRef.current?.value ?? "";
    if (q.trim()) {
      send(q);
      if (textareaRef.current) textareaRef.current.value = "";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  };

  const handleChipClick = (query: string) => {
    if (textareaRef.current) {
      textareaRef.current.value = query;
      textareaRef.current.focus();
    }
  };

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>
            Copilot <span className={styles.sub}>RAG over statutes + live events</span>
          </h2>
        </div>
      </div>

      <div className={styles.chat} ref={chatRef}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`${styles.msg} ${styles[msg.role]} ${msg.isError ? styles.err : ""}`}
          >
            {msg.text}
          </div>
        ))}
      </div>

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

      <form className={styles.compose} onSubmit={handleSubmit} autoComplete="off">
        <textarea
          ref={textareaRef}
          placeholder="Ask Copilot… (Enter to send, Shift+Enter = newline)"
          onKeyDown={handleKeyDown}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
