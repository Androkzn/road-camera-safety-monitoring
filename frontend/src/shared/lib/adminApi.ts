/**
 * adminApi.ts — admin-bearer fetch helpers used by any feature that
 * touches admin-tier endpoints (settings, watchdog mutations, baseline
 * capture, etc).
 *
 * Token storage decision (sessionStorage, not localStorage): smaller XSS
 * attack window and the operator who walks away from a shared workstation
 * doesn't leave a token sitting on disk.
 *
 * CSRF posture: the browser does NOT auto-attach the Authorization header
 * (unlike cookies), so CSRF is structurally impossible against these
 * endpoints. If we ever switch to cookie auth, add CSRF tokens.
 */

const STORAGE_KEY = "road_admin_token";
const CHANNEL_NAME = "admin-token";

export class MissingAdminTokenError extends Error {
  constructor() {
    super("missing admin bearer token");
    this.name = "MissingAdminTokenError";
  }
}

// BroadcastChannel is the only way to sync `sessionStorage`-scoped state
// across tabs within the same browser session: `storage` events fire only
// for `localStorage`, and a `window.dispatchEvent` hits only the current
// window. Broadcasting on set/clear means a second tab opened during the
// same session hears the change and updates its cached token immediately.
// If the browser disables BroadcastChannel (older Safari, locked-down
// extensions) we gracefully fall back to the same-tab dispatch only.
const _channel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(CHANNEL_NAME)
      : null;
  } catch {
    return null;
  }
})();

/** Notify listeners (current tab + other same-origin tabs) that the token changed. */
function _notifyTokenChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent("admin-token-changed"));
  } catch {
    /* ignore */
  }
  try {
    _channel?.postMessage({ type: "admin-token-changed" });
  } catch {
    /* ignore */
  }
}

/**
 * Subscribe to admin-token changes in the current tab *and* across tabs
 * in the same browser session. `listener` fires immediately if the token
 * was cleared / set elsewhere.
 *
 * Returns an unsubscribe callback.
 */
export function subscribeToAdminTokenChanges(listener: () => void): () => void {
  const same = () => listener();
  window.addEventListener("admin-token-changed", same);
  const onMessage = (ev: MessageEvent) => {
    if (ev?.data?.type === "admin-token-changed") listener();
  };
  _channel?.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("admin-token-changed", same);
    _channel?.removeEventListener("message", onMessage);
  };
}

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
    _notifyTokenChanged();
  } catch {
    // sessionStorage can be denied by privacy modes; ignore.
  }
}

export function clearAdminToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    _notifyTokenChanged();
  } catch {
    /* ignore */
  }
}

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
 * Typed structured error returned by admin endpoints.
 * 422: validation `{errors: [{key, reason}]}`
 * 409: revision conflict `{error: "revision_conflict", expected, actual}`
 * 429: rate-limited (with `Retry-After` header)
 * 401/403/503: auth failures
 */
export interface AdminApiError extends Error {
  status: number;
  body: unknown;
  retryAfterSec?: number;
}

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

/** True if `exc` is an admin auth failure that should drop the cached token. */
export function isAdminAuthFailure(exc: unknown): boolean {
  const status = (exc as AdminApiError | undefined)?.status;
  return status === 401 || status === 403 || status === 503;
}
