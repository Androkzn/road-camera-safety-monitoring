/**
 * Pure error-shape predicates for the Settings apply flow.
 *
 * The settings router throws `HttpApiError`s whose `body` field carries
 * a structured discriminator — `body.error` for single-string reasons
 * (like "privacy_confirm_required") and `body.errors[]` for per-key
 * validation rejections. These helpers narrow `unknown` errors thrown
 * from the fetch client into the typed shapes the page can render.
 *
 * Both predicates are defensive: they fully probe the error's runtime
 * shape before reading any field, so they're safe to call on any
 * `catch (exc)` value including network errors, AbortError, etc.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: No direct UI — helper used by the SettingsPage components to
 *   recognise validation/privacy errors returned by the Apply flow.
 * Backend: Decodes errors from POST /api/settings/apply.
 * Consumers: {@link classifyApplyError} (the error discriminator used by
 *   `useSettingsApply`) and any direct callers that need to distinguish
 *   422/400 structured errors from other failures.
 */
import type { HttpApiError } from "../../../shared/lib/fetchClient";

/**
 * `true` iff `exc` is the specific 400 response the server returns when
 * a privacy-sensitive tunable (e.g. ALPR_MODE) is being toggled without
 * the `confirm_privacy_change` flag set.
 *
 * Returns synchronously; never throws. Used by the apply-error classifier
 * to route to the privacy-confirm dialog.
 */
export function isPrivacyConfirmRequired(exc: unknown): boolean {
  return (
    !!exc &&
    typeof exc === "object" &&
    (exc as HttpApiError).status === 400 &&
    (exc as HttpApiError).body !== null &&
    typeof (exc as HttpApiError).body === "object" &&
    ((exc as HttpApiError).body as { error?: string }).error === "privacy_confirm_required"
  );
}

/**
 * Pull per-key validation errors out of a 422 response, or return `null`
 * if the error doesn't match that shape.
 *
 * Returns:
 *   - `Array<{ key, reason }>` when `exc.status === 422` and the body
 *     parsed into an object carrying an `errors` array.
 *   - `null` for everything else (including 422s without an `errors`
 *     key) so the caller can fall through to its generic error branch.
 *
 * Synchronous; never throws.
 */
export function extractValidationErrors(
  exc: unknown,
): Array<{ key: string; reason: string }> | null {
  if (
    exc &&
    typeof exc === "object" &&
    (exc as HttpApiError).status === 422 &&
    (exc as HttpApiError).body !== null &&
    typeof (exc as HttpApiError).body === "object"
  ) {
    const body = (exc as HttpApiError).body as {
      errors?: Array<{ key: string; reason: string }>;
    };
    return body.errors ?? null;
  }
  return null;
}
