/**
 * Pure error-shape predicates for the Settings apply / rollback flow.
 *
 * The settings router throws structured errors with `body.error` /
 * `body.errors` discriminators; these helpers narrow them to typed
 * shapes the page can render.
 */
import type { HttpApiError } from "../../../shared/lib/fetchClient";

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
