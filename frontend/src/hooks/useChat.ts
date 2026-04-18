/**
 * useChat — small state machine for the dashboard Copilot chat panel.
 * Holds the rolling message list, a `loading` flag while the LLM responds,
 * and a `send(text)` function that appends a user message, hits the chat
 * API, then appends the bot reply (or an error bubble on failure).
 *
 * TEACH: A "custom hook" is any `use*` function that may call other hooks
 * internally (`useState`, `useCallback`, ...). Packaging this logic as a
 * hook — rather than scattering useState/useState/useCallback directly
 * inside CopilotPanel.tsx — keeps the component declarative (just renders
 * the props) and makes the state machine independently testable.
 *
 * Return shape:
 *   { messages, loading, send }
 *   - `messages` — ChatMessage[] including the initial welcome line.
 *   - `loading`  — true while an API call is in flight; also used by
 *                  `send` to guard against double-submits.
 *   - `send(q)`  — async; no-op on empty text or while loading.
 *
 * Consumers:
 *   - components/dashboard/CopilotPanel.tsx
 */
import { useState, useCallback } from "react";
import { api } from "../lib/api";

interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  isError?: boolean;
}

// TEACH: Module-scoped mutable counter used purely to generate unique IDs
// for React list `key` props. It lives OUTSIDE the hook, so it's shared
// across every component that mounts useChat — that's deliberate here
// because we only need global uniqueness, not per-instance. If you ever
// need per-chat-session IDs, move this into a useRef instead.
let msgCounter = 0;

export function useChat() {
  // --- Local state ---
  // TEACH: useState(initial) returns [value, setter]. Passing a plain value
  // (not a function) for `initial` means the array literal is re-created
  // on every render but React only reads it on the first render. If the
  // initial value were expensive to build, prefer the LAZY form:
  //   useState(() => expensiveInit())
  // which React calls only once.
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "bot",
      text: "Ask about recent events, risk patterns, or road safety policy.",
    },
  ]);
  const [loading, setLoading] = useState(false);

  // --- send(): the state-machine step ---
  // TEACH: useCallback memoizes the function's identity across renders.
  // Deps here are [loading] because `send` reads `loading` to guard
  // double-submit. Without useCallback, every render would produce a new
  // `send` reference and any <button onClick={send}> in a React.memo'd
  // child would treat it as a prop change and re-render unnecessarily.
  const send = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    const userId = `msg-${++msgCounter}`;
    const botId = `msg-${++msgCounter}`;

    // TEACH: Functional updater form `setMessages(prev => next)` is the
    // safe way to append to a list because it reads the latest committed
    // value of `prev` even if the caller had a stale closure — common
    // when handlers fire multiple times quickly. Always prefer this over
    // `setMessages([...messages, item])` when you depend on the old list.
    setMessages((prev) => [...prev, { id: userId, role: "user", text: trimmed }]);
    setLoading(true);

    try {
      const { answer } = await api.chat(trimmed); // lib/api.ts
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
      // `finally` ensures loading is cleared even if the API call throws.
      setLoading(false);
    }
  }, [loading]);

  return { messages, loading, send };
}
