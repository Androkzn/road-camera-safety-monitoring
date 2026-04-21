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
import { useState, useCallback } from "react";
import { api } from "../lib/api";

interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  isError?: boolean;
}

let msgCounter = 0;

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "bot",
      text: "Ask about recent events, risk patterns, or road safety policy.",
    },
  ]);
  const [loading, setLoading] = useState(false);

  const send = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    const userId = `msg-${++msgCounter}`;
    const botId = `msg-${++msgCounter}`;

    setMessages((prev) => [...prev, { id: userId, role: "user", text: trimmed }]);
    setLoading(true);

    try {
      const { answer } = await api.chat(trimmed);
      setMessages((prev) => [
        ...prev,
        { id: botId, role: "bot", text: answer || "(no answer)" },
      ]);
    } catch (err) {
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
      setLoading(false);
    }
  }, [loading]);

  return { messages, loading, send };
}
