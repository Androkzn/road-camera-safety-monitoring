/**
 * fetchClient — typed fetch helpers for feature `api.ts` modules.
 *
 * Centralises `cache: "no-store"`, JSON parsing, and structured HTTP errors
 * (`HttpApiError`) for endpoints that return validation / rate-limit bodies.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Convenience wrapper for JSON POST requests with a typed body. */
export async function postJson<T, B = unknown>(
  url: string,
  body: B,
  init?: RequestInit,
): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

/**
 * Structured error from JSON APIs (422 validation, 409 conflict, 429, etc.).
 */
export interface HttpApiError extends Error {
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

/** Same as `fetch` + JSON parse on success; throws `HttpApiError` on non-OK. */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers, cache: "no-store" });
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
    retryHeader != null && /^\d+$/.test(retryHeader.trim()) ? parseInt(retryHeader, 10) : undefined;
  const err = new Error(buildErrorMessage(res.status, body, retryAfterSec)) as HttpApiError;
  err.status = res.status;
  err.body = body;
  err.retryAfterSec = retryAfterSec;
  throw err;
}
