/**
 * adminApi.ts — admin-bearer fetch helpers for the Settings Console.
 *
 * Why a separate module from `lib/api.ts`?
 *   `lib/api.ts` documents itself as the public-tier surface and intentionally
 *   does NOT include any Bearer-protected routes. The Settings Console hits
 *   admin endpoints under `/api/settings/*`, all of which require an
 *   `Authorization: Bearer <ROAD_ADMIN_TOKEN>` header. Mixing the two would
 *   make it too easy to accidentally introduce a public alias for a
 *   privileged route.
 *
 * Token storage decision (sessionStorage, not localStorage):
 *   - sessionStorage: cleared on tab close. Smaller XSS attack window.
 *   - localStorage: persists across browser restarts; larger attack surface
 *     because any XSS on the same origin can read it for as long as the
 *     user keeps the browser installed.
 *   We choose sessionStorage so an operator who walks away from a shared
 *   workstation does not leave the admin token sitting in disk.
 *
 * CSRF posture:
 *   The browser does NOT auto-attach the Authorization header (unlike
 *   cookies). That makes CSRF structurally impossible against these
 *   endpoints. If we ever switch to cookie auth, we MUST add CSRF tokens
 *   — flag this comment.
 */

const STORAGE_KEY = "road_admin_token";

/** Thrown when an admin call is attempted without a token configured. */
export class MissingAdminTokenError extends Error {
  constructor() {
    super("missing admin bearer token");
    this.name = "MissingAdminTokenError";
  }
}

/** Read the cached admin token from sessionStorage, or null. */
export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Stash the token. The TopBar emits a custom event so listeners can refresh. */
export function setAdminToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
    window.dispatchEvent(new CustomEvent("admin-token-changed"));
  } catch {
    // sessionStorage can be denied by privacy modes; ignore.
  }
}

/** Forget the cached token (Settings page exposes this as "Forget token"). */
export function clearAdminToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent("admin-token-changed"));
  } catch {
    // ignore
  }
}

/**
 * Internal: build a `RequestInit` with the Authorization header injected.
 * Throws `MissingAdminTokenError` if no token has been cached — the caller is
 * expected to catch that and prompt for one.
 */
function withAdminAuth(init?: RequestInit): RequestInit {
  const token = getAdminToken();
  if (!token) throw new MissingAdminTokenError();
  const headers = new Headers(init?.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return { ...init, headers, cache: "no-store" };
}

/**
 * Typed structured error returned by the Settings API.
 * The Python side returns 422 with `{errors: [{key, reason}]}` for validation,
 * 409 with `{error: "revision_conflict", expected, actual}` for ETag misses,
 * 429 for the apply cooldown (with a `Retry-After` header), and 401/403/503
 * for auth failures.
 */
export interface AdminApiError extends Error {
  status: number;
  body: unknown;
  /** Seconds the server asked us to wait, parsed from `Retry-After`. */
  retryAfterSec?: number;
}

/**
 * Build a human-readable error message from a non-OK response. The order
 * of preference is:
 *   1. server-supplied `detail` string (FastAPI's HTTPException default)
 *   2. server-supplied `error` string (custom error envelopes)
 *   3. fallback to `HTTP <status>`
 * For 429 we prepend a "Too many attempts — retry in Ns" prefix using the
 * `Retry-After` header so the user sees an actionable message in the UI
 * rather than the raw "HTTP 429".
 */
function buildErrorMessage(
  status: number,
  body: unknown,
  retryAfterSec: number | undefined,
): string {
  const detail =
    body && typeof body === "object" && "detail" in body
      ? String((body as { detail: unknown }).detail)
      : null;
  const errorField =
    body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : null;
  const base = detail ?? errorField ?? `HTTP ${status}`;
  if (status === 429 && retryAfterSec != null && retryAfterSec > 0) {
    return `Too many apply attempts. Retry in ${retryAfterSec}s. (${base})`;
  }
  return base;
}

export async function adminFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, withAdminAuth(init));
  if (res.ok) {
    return (await res.json()) as T;
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  // Retry-After is sent as integer seconds by the settings router. The
  // RFC also allows an HTTP-date but we don't emit that, so a parseInt
  // is sufficient and degrades cleanly (NaN → undefined) for other shapes.
  const retryHeader = res.headers.get("Retry-After");
  const retryAfterSec =
    retryHeader != null && /^\d+$/.test(retryHeader.trim())
      ? parseInt(retryHeader, 10)
      : undefined;
  const err = new Error(buildErrorMessage(res.status, body, retryAfterSec)) as AdminApiError;
  err.status = res.status;
  err.body = body;
  err.retryAfterSec = retryAfterSec;
  throw err;
}
