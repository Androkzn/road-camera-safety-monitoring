/**
 * fetchClient — typed fetch helpers for feature `api.ts` modules.
 *
 * Centralises `cache: "no-store"`, JSON parsing, and structured HTTP errors
 * (`HttpApiError`) for endpoints that return validation / rate-limit bodies.
 *
 * `cache: "no-store"` is essential for a real-time ops console — without it
 * some browsers will hand back a stale response from their HTTP cache.
 *
 * --- UI mapping ---
 * Used on: All pages (utility — no UI of its own). Every feature's
 *   api.ts module on AdminPage, DashboardPage, MonitoringPage,
 *   SettingsPage and ValidationPage routes its HTTP calls through here.
 * UI element: no element — typed fetch helpers and a structured HTTP
 *   error class that backs every JSON request the UI makes.
 */

/**
 * Minimal GET/parse helper. Generic `<T>` is the expected response shape;
 * TypeScript can't verify it at runtime, so features add narrow type
 * guards where the contract is risky.
 */
// `fetchJson` — lightweight helper for read endpoints. `<T>` is what the caller
// expects back; `init` is an optional standard `RequestInit` (method, headers,
// signal, body, etc.) that is forwarded to the browser's `fetch`.
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  // Call the browser `fetch`. `cache: "no-store"` is set FIRST so that if the
  // caller's `init` also sets `cache`, theirs wins (spread comes after).
  // In practice we want no-store everywhere, so callers don't override it.
  const res = await fetch(url, { cache: "no-store", ...init });
  // Any non-2xx status is an error here. This helper is intentionally dumb —
  // it does NOT try to parse the error body. Use `apiFetch` when you need
  // the server's error payload (422 validation details, Retry-After, etc.).
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Parse the body as JSON and cast to `T`. The cast is unchecked at runtime;
  // TypeScript trusts the caller's annotation. Features guard risky shapes.
  return res.json();
}

/** Convenience wrapper for JSON POST requests with a typed body. */
// `postJson` — same idea as `fetchJson` but for POST. `<T>` is the response
// shape; `<B>` is the request-body shape (defaults to `unknown` so callers
// are forced to annotate when type-safety matters).
export async function postJson<T, B = unknown>(
  url: string,
  body: B,
  init?: RequestInit,
): Promise<T> {
  // Delegate to `fetchJson` so we inherit `cache: "no-store"` + error semantics.
  return fetchJson<T>(url, {
    // Override the HTTP verb. `fetchJson` defaults to GET via the browser.
    method: "POST",
    // Content-Type has to be JSON because we're stringifying below. Caller's
    // headers are spread AFTER so they can override (e.g. custom Accept).
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    // Serialise the typed body. `JSON.stringify` handles dates, numbers, etc.
    body: JSON.stringify(body),
    // Spread the rest of `init` last so callers can pass `signal`, `credentials`,
    // etc. Note: this CAN override method/headers/body above — that's intentional
    // so callers have an escape hatch if they need it.
    ...init,
  });
}

/**
 * Structured error from JSON APIs (422 validation, 409 conflict, 429, etc.).
 */
// `HttpApiError` extends the standard `Error` with three fields the UI needs:
//   - `status`: so `onError` branches can switch on HTTP code
//   - `body`:   the parsed server payload (FastAPI `detail`, validation array, …)
//   - `retryAfterSec`: parsed from the `Retry-After` header when present (429s)
export interface HttpApiError extends Error {
  status: number;
  body: unknown;
  retryAfterSec?: number;
}

// `buildErrorMessage` — produces the human-readable `err.message` string.
// Pure function, no I/O. Lives outside `apiFetch` so it's unit-testable.
function buildErrorMessage(
  status: number,
  body: unknown,
  retryAfterSec: number | undefined,
): string {
  // Look for FastAPI's standard shape: `{ "detail": "..." }` or
  // `{ "detail": [ ... ] }` for 422s. Defensive type-narrowing because
  // `body` is `unknown` — we only read `detail` if the body is an object
  // and actually has that key.
  const detail =
    body && typeof body === "object" && "detail" in body
      ? String((body as { detail: unknown }).detail)
      : null;
  // Fallback: hand-rolled routers sometimes return `{ "error": "..." }`.
  // Same narrowing pattern — treat `body` as opaque until we've checked.
  const errorField =
    body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : null;
  // Prefer `detail`, then `error`, then a generic `HTTP 500`-style string.
  // `??` (nullish coalescing) skips `null` but keeps empty strings — if the
  // server sends `detail: ""` we show it rather than lying with a generic.
  const base = detail ?? errorField ?? `HTTP ${status}`;
  // Special case: 429 rate-limit responses. If the server gave us a
  // `Retry-After` seconds value, render it into the message so the toast
  // copy reads "Retry in 12s" without every caller having to special-case it.
  if (status === 429 && retryAfterSec != null && retryAfterSec > 0) {
    return `Too many apply attempts. Retry in ${retryAfterSec}s. (${base})`;
  }
  // Normal path — just the server's message (or our generic fallback).
  return base;
}

/** Same as `fetch` + JSON parse on success; throws `HttpApiError` on non-OK. */
// `apiFetch` — the real workhorse. Use this for every endpoint where the UI
// might want to inspect the error body (validation, rate-limits, conflicts).
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // Promote `init.headers` to a `Headers` instance so we can call `.has()` /
  // `.set()` below. Works whether the caller passed a plain object, an array,
  // or an existing `Headers`. Empty `{}` is fine when no headers given.
  const headers = new Headers(init?.headers ?? {});
  // Auto-set `Content-Type: application/json` ONLY if:
  //   (a) the caller provided a body (so we're POST/PUT/PATCH-ing), and
  //   (b) they haven't already specified a Content-Type
  // This avoids clobbering e.g. `multipart/form-data` when someone uploads.
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  // The actual network call. Spread `init` FIRST so our `headers` + `cache`
  // override any caller values — we want those invariants always enforced.
  // The `signal` from `init` (if any) passes through untouched, which is how
  // TanStack Query's auto-cancel-on-unmount works with this helper.
  const res = await fetch(url, { ...init, headers, cache: "no-store" });
  // Happy path: 2xx → parse JSON and cast to `T`. Same runtime-unchecked cast
  // as `fetchJson`; callers narrow risky shapes at the feature boundary.
  if (res.ok) {
    return (await res.json()) as T;
  }
  // Error path. Start with `null` so even if body-parse throws we have a value.
  let body: unknown = null;
  // Try to parse the error body as JSON. Many FastAPI errors include a
  // structured `detail` — we want to preserve it for the caller. Wrap in
  // try/catch because some errors (502s from a proxy, plain-text 500s) will
  // not be valid JSON and `.json()` would throw.
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body — leave `body = null`. The message builder will
    // fall through to the generic `HTTP <status>` string.
    body = null;
  }
  // Pull `Retry-After` off the response headers. FastAPI rate-limiter sets
  // this for 429s. Header may be absent on other errors — that's fine.
  const retryHeader = res.headers.get("Retry-After");
  // Only accept an integer-seconds format (`/^\d+$/`). The spec also allows
  // an HTTP-date, but our server never sends that and parsing one adds bugs.
  // `.trim()` handles stray whitespace from odd proxies.
  const retryAfterSec =
    retryHeader != null && /^\d+$/.test(retryHeader.trim()) ? parseInt(retryHeader, 10) : undefined;
  // Build the structured error. We create a plain `Error` with the rendered
  // message (so stack traces + devtools behave normally), then cast and
  // attach our extra fields. This is cheaper than a custom class and keeps
  // `instanceof Error` true for any generic error-boundary logic.
  const err = new Error(buildErrorMessage(res.status, body, retryAfterSec)) as HttpApiError;
  err.status = res.status;
  err.body = body;
  err.retryAfterSec = retryAfterSec;
  // Throw it. TanStack Query will capture this as `error` on the query/mutation;
  // feature-level `onError` handlers can `instanceof Error` + read `.status`.
  throw err;
}
