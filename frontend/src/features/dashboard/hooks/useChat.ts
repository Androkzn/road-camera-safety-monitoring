/**
 * useChat — small state machine for the dashboard Copilot chat panel.
 * Holds the rolling message list, a `loading` flag, and a `send(text)`
 * function that appends a user turn, hits the chat API, then appends
 * the bot reply (or an error bubble on failure).
 *
 * Why a custom hook? Keeps CopilotPanel.tsx purely presentational.
 * Another page could reuse the chat widget without copying logic.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — supplies the messages, loading state, and
 *   send() function for the Copilot chat panel on the right of the dashboard.
 * Backend: POST /chat
 */
import { useState, useCallback, useRef } from "react";

import { dashboardApi } from "../api";

// TEACH: `role: "user" | "bot"` is a union of string literals. A
// ChatMessage can only have one of these two values for `role` —
// TypeScript will flag any typo.
interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  isError?: boolean;
}

/** Chat state machine: messages list, loading flag, `send(text)`. */
export function useChat() {
  // TEACH: `useRef(0)` holds a mutable counter used to mint unique
  // message ids. Refs don't trigger re-renders on write — perfect for
  // monotonic counters that must not cause UI churn.
  const msgCounter = useRef(0);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "bot",
      text: "Ask about recent events, risk patterns, or road safety policy.",
    },
  ]);
  const [loading, setLoading] = useState(false);

  // TEACH: `useCallback` memoises the `send` function — its identity
  // is stable unless `loading` changes. Keeps child components that
  // receive `send` as a prop from re-rendering on every parent render.
  const send = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      // Guard: ignore empty submits and double-submits while in-flight.
      if (!trimmed || loading) return;

      const userId = `msg-${++msgCounter.current}`;
      const botId = `msg-${++msgCounter.current}`;

      setMessages((prev) => [...prev, { id: userId, role: "user", text: trimmed }]);
      setLoading(true);

      try {
        const { answer } = await dashboardApi.chat(trimmed);
        setMessages((prev) => [...prev, { id: botId, role: "bot", text: answer || "(no answer)" }]);
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
    },
    [loading],
  );

  return { messages, loading, send };
}
