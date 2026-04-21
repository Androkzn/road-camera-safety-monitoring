/**
 * useChat.ts — custom hook that holds a simple Q&A chat transcript.
 *
 * What it does:
 *   Tracks a list of chat messages (user + bot), a loading flag, and a
 *   send() function that posts a user query to the backend /chat endpoint
 *   and appends both the user message and the bot's answer to the list.
 *
 * Purpose:
 *   Powers the "Copilot" chat panel on the dashboard page. Keeps all chat
 *   state management in one reusable hook so the UI component stays thin.
 *
 * How it works:
 *   - A "custom hook" is a reusable function starting with `use` that
 *     encapsulates stateful logic.
 *   - useState: holds the `messages` array (seeded with a welcome message)
 *     and the `loading` flag. Changing either re-renders the caller.
 *   - useCallback: caches the `send` function so it only changes when
 *     `loading` changes. This avoids re-creating it on every render.
 *   - `msgCounter` is a module-level variable (not React state) used to
 *     generate stable unique IDs for messages across renders.
 *   - Union types here: `role: "user" | "bot"` means the role field must
 *     be exactly one of those two strings.
 *   - `setMessages((prev) => [...prev, ...])` uses the functional form of
 *     setState: React passes the latest state so updates don't clobber
 *     each other when called in quick succession.
 *
 * Connects to:
 *   - Backend: POST /chat (via api.chat) — defined in road_safety/server.py,
 *     takes a {query} body and returns {answer}.
 *   - UI: used by frontend/src/components/dashboard/CopilotPanel.tsx, which
 *     renders on DashboardPage.tsx at "/dashboard".
 */
// React imports: useState re-renders on change; useCallback caches a function across renders.
import { useState, useCallback } from "react";
import { api } from "../lib/api";

// Shape of a single chat bubble. Union `"user" | "bot"` = exactly one of those two strings.
// `isError?` = optional field (may be missing).
interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  isError?: boolean;
}

// Module-level counter (not React state) — simple way to hand out unique IDs without re-renders.
let msgCounter = 0;

// useChat — owns the chat transcript + send(); returns { messages, loading, send }.
// Consumed by: frontend/src/components/dashboard/CopilotPanel.tsx on DashboardPage.tsx.
export function useChat() {
  // Transcript array seeded with a welcome bot message; mutating it re-renders the panel.
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "bot",
      text: "Ask about recent events, risk patterns, or road safety policy.",
    },
  ]);
  // Disables the input + send button while a request is in flight.
  const [loading, setLoading] = useState(false);

  // `send` is rebuilt only when `loading` changes; guards against concurrent submissions.
  const send = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    // Pre-increment (++x) bumps the counter first, then returns the new value.
    const userId = `msg-${++msgCounter}`;
    const botId = `msg-${++msgCounter}`;

    // Functional setState + spread: append a new bubble without mutating the previous array.
    setMessages((prev) => [...prev, { id: userId, role: "user", text: trimmed }]);
    setLoading(true);

    try {
      // Backend: POST /chat via api.chat. `const { answer } = ...` destructures the response object.
      const { answer } = await api.chat(trimmed);
      setMessages((prev) => [
        ...prev,
        // `answer || "(no answer)"` = fallback when the server returns an empty string.
        { id: botId, role: "bot", text: answer || "(no answer)" },
      ]);
    } catch (err) {
      // Append an error bubble so the operator sees failures inline instead of a silent send.
      setMessages((prev) => [
        ...prev,
        {
          id: botId,
          role: "bot",
          text: `(error: ${err instanceof Error ? err.message : err})`,
          isError: true,
        },
      ]);
    } finally {
      // Always clear loading so a failure doesn't permanently disable the input.
      setLoading(false);
    }
  }, [loading]);

  return { messages, loading, send };
}
