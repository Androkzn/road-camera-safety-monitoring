/**
 * Tests API surface — pytest runner integration.
 *
 * Two endpoints: `GET /api/tests/status` for the latest run, and
 * `POST /api/tests/run` to kick off a new run. The hook in
 * `hooks/useTests.ts` is the only caller.
 *
 * --- UI mapping ---
 * Page: Global (TopBar of every page).
 * UI element: No direct UI — wraps the test endpoints used by the
 *   TopBar tests badge and its drawer.
 * Backend: GET /api/tests/status, POST /api/tests/run.
 */
import { fetchJson } from "../../shared/lib/fetchClient";
import type { TestStatus } from "../../shared/types/common";

/**
 * Small object with one method per endpoint. `fetchJson<T>` is a
 * generic: `<T>` is the expected response shape, so the return type
 * is `Promise<T>` and callers get autocomplete on the parsed JSON.
 */
export const testsApi = {
  getStatus: (signal?: AbortSignal) => fetchJson<TestStatus>("/api/tests/status", { signal }),
  run: () => fetchJson<{ ok: boolean }>("/api/tests/run", { method: "POST" }),
};

/**
 * Centralised TanStack Query cache keys for this feature. `as const`
 * keeps them as readonly tuples of literal strings, which TanStack
 * requires for key-based invalidation to type-check.
 */
export const testsQueryKeys = {
  all: ["tests"] as const,
  status: ["tests", "status"] as const,
};
