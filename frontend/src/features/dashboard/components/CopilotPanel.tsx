/**
 * CopilotPanel — LLM chat widget. State + send/receive lives in useChat.
 *
 * Renders the chat log, a row of suggestion chips, and the compose
 * box. Holds no chat state itself — that's delegated to `useChat` so
 * the widget can be dropped into other pages without changes.
 *
 * React/TS concepts first introduced in this file:
 *   - `useRef<HTMLDivElement>(null)` — handle to a DOM node for
 *     imperative access (here we scroll the chat log to the bottom).
 *   - Passing `ref={someRef}` to a JSX element.
 *   - `type FormEvent / KeyboardEvent` — typed React synthetic events.
 *   - `useEffect` that reacts to an array (`messages`) changing.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: the chat panel on the right side of the dashboard that
 *   talks to the AI Copilot — chat log, suggestion chips, and the
 *   compose box at the bottom.
 * Backend: POST /chat
 */

// TEACH: `type` imports before the identifier restrict the import to
// the TypeScript type — erased at build time, zero runtime cost.
import { useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";

import { useChat } from "../hooks/useChat";

import styles from "./CopilotPanel.module.css";

// Static list of suggestion chips rendered above the compose box.
const CHIPS = [
  {
    label: "Any high-risk pedestrian events?",
    query: "Any high-risk pedestrian events in the last 2 minutes?",
  },
  {
    label: "Medium-risk SLA?",
    query: "What's our SLA for medium-risk events?",
  },
  { label: "Summarize last 10 events", query: "Summarize the last 10 events." },
];

/**
 * Copilot widget. Takes no props — owns its own input via a ref and
 * delegates chat state (messages / loading / send) to `useChat`.
 */
export function CopilotPanel() {
  const { messages, loading, send } = useChat();

  // TEACH: `useRef` creates a cell whose `.current` points to the
  // underlying DOM node after mount. We use refs instead of controlled
  // inputs here because the textarea is "uncontrolled" — we only read
  // its value on submit, so there's no need to re-render on every
  // keystroke.
  const chatRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll the chat log to the bottom whenever a new message lands.
  // The dep `[messages]` makes this run after every message mutation.
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

  // Enter submits, Shift+Enter inserts a newline (standard chat UX).
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // `as unknown as FormEvent` is a two-step cast — TS refuses a
      // direct cast between unrelated event types so we detour through
      // `unknown`. The handler only reads `.preventDefault()`, so the
      // synthetic mismatch is safe at runtime.
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
