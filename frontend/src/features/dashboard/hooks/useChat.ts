/**
 * useChat — small state machine for the dashboard Copilot chat panel.
 * Holds the rolling message list, a `loading` flag, and a `send(text)`
 * function that appends a user turn, hits the chat API, then appends
 * the bot reply (or an error bubble on failure).
 *
 * Why a custom hook? Keeps CopilotPanel.tsx purely presentational.
 * Another page could reuse the chat widget without copying logic.
 *
 * Queries/mutations: plain local React state (useState + useRef). No
 * TanStack Query involvement — chat is transient, one-shot, and does
 * not need cache sharing. Send is a manual POST via dashboardApi.chat.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: No direct UI — supplies the messages, loading state, and
 *   send() function for the Copilot chat panel on the right of the dashboard.
 * Consumer component: CopilotPanel
 *   ([file](frontend/src/features/dashboard/components/CopilotPanel.tsx))
 *   destructures { messages, loading, send } and renders the bubble list +
 *   input box.
 * Backend: POST /chat — copilot LLM chat endpoint; backend enriches with
 *   recent event context and returns `{ answer: string }`.
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

/**
 * Chat state machine: messages list, loading flag, `send(text)`.
 *
 * Params: none.
 * Returns:
 *   - `messages`: ChatMessage[] — ordered list (oldest first), seeded with a
 *       "welcome" bot bubble so the panel is never empty on mount.
 *   - `loading`: boolean — true while a request is in flight; used by the
 *       panel to disable the input and show a typing indicator.
 *   - `send(query)`: async (text) => void — appends a user bubble, POSTs to
 *       `/chat`, appends a bot bubble on success or an error bubble on
 *       failure. No-ops on empty input or when already loading.
 *
 * Error behaviour: network/server failures are caught and surfaced as an
 *   inline error ChatMessage (`isError: true`) rather than throwing. The
 *   hook never rejects; CopilotPanel can render unconditionally.
 *
 * Cache/staleness: N/A. Messages are component-local state — unmounting
 *   CopilotPanel (e.g. navigating away) discards the conversation.
 */
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

      // Pre-mint both ids up front (pre-increment so we never reuse id 0).
      // Doing this before the await keeps ids monotonic even if two sends
      // race — each awaited send already captures its own userId/botId.
      const userId = `msg-${++msgCounter.current}`;
      const botId = `msg-${++msgCounter.current}`;

      // Optimistic append: user bubble appears instantly, before the
      // network round-trip. The bot bubble is appended later in try/catch.
      setMessages((prev) => [...prev, { id: userId, role: "user", text: trimmed }]);
      setLoading(true);

      try {
        // Backend contract: `{ answer: string }`. Empty string → fall
        // back to "(no answer)" so the bubble never renders blank.
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
