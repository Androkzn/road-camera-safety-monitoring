/**
 * useSettingsApply — owns the Settings Console draft lifecycle.
 *
 * Composes on top of `useSettings` and `useImpact` and turns them into
 * a single page-shaped state object:
 *   - mirrors effective values into a local `draft` on first load;
 *   - derives `dirtyKeys` by diffing draft against effective;
 *   - wraps `settings.apply` with error classification and dialog-driven
 *     recovery flows (validation errors, privacy confirmation,
 *     revision conflict, rate-limit backoff);
 *   - exposes banner state for success reporting.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: Drives the Apply flow behind the Apply / Discard buttons in
 *   the SettingsHeader and the resulting ApplyResultBanner.
 * Backend: POST /api/settings/apply (with privacy/revision handling).
 * Consumers: `SettingsPage` only — this hook is the single orchestrator
 *   for the draft → apply state machine.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { HttpApiError } from "../../../shared/lib/fetchClient";
import type { DialogApi } from "../../../shared/ui";

import type { ApplyResultPayloadView } from "../components/ApplyResultBanner";
import { extractValidationErrors, isPrivacyConfirmRequired } from "../utils/validation";
import type { ApplyResultPayload, DraftValue } from "../types";

import type { SettingsState } from "./useSettings";
import type { ImpactState } from "./useImpact";

interface UseSettingsApplyArgs {
  settings: SettingsState;
  impact: ImpactState;
  dialog: DialogApi;
}

/**
 * Discriminator for branches of the apply error-recovery switch.
 * See {@link classifyApplyError} for how each kind is detected and
 * {@link useSettingsApply} for the recovery behaviour per kind.
 */
export type ApplyErrorKind =
  | "validation"
  | "privacy_confirm"
  | "revision_conflict"
  | "rate_limited"
  | "unknown";

/**
 * Classify a thrown error from `settings.apply` into a recovery branch.
 *
 * Detection order matters:
 *   1. 422 with `body.errors[]` → `"validation"` (per-key rejections).
 *   2. 400 with `body.error === "privacy_confirm_required"` → `"privacy_confirm"`.
 *   3. HTTP 409 → `"revision_conflict"` (optimistic-concurrency stale hash).
 *   4. HTTP 429 → `"rate_limited"`.
 *   5. Anything else → `"unknown"` (fall through to a generic alert).
 *
 * Returns synchronously; pure function.
 */
export function classifyApplyError(exc: unknown): ApplyErrorKind {
  if (extractValidationErrors(exc)) return "validation";
  if (isPrivacyConfirmRequired(exc)) return "privacy_confirm";
  const status = (exc as Partial<HttpApiError>).status;
  if (status === 409) return "revision_conflict";
  if (status === 429) return "rate_limited";
  return "unknown";
}

/**
 * Public return shape of {@link useSettingsApply}.
 *
 * - `draft` / `setDraft`      — local working copy of tunable values; the
 *   hook seeds this from `settings.effective` on first load.
 * - `dirtyKeys`               — keys whose draft value differs from effective
 *   (drives the "pending" pill and the Apply button enablement).
 * - `validationErrors`        — per-key rejections from the last 422 response.
 * - `warnings`                — non-fatal server warnings from the last success.
 * - `applyResult`             — payload for the success banner, or `null`.
 * - `submitting`              — true while an apply is in flight.
 * - `apply`                   — trigger apply of `dirtyKeys`; handles all
 *   recovery branches via the injected `dialog` API.
 * - `discardDraft`            — reset draft back to effective (no network).
 * - `dismissApplyResult`      — clear the success banner.
 */
export interface UseSettingsApplyResult {
  draft: Record<string, DraftValue>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, DraftValue>>>;
  dirtyKeys: string[];
  validationErrors: Array<{ key: string; reason: string }>;
  warnings: string[];
  applyResult: ApplyResultPayloadView | null;
  submitting: boolean;
  apply: () => Promise<void>;
  discardDraft: () => void;
  dismissApplyResult: () => void;
}

/**
 * Orchestrate the draft → apply → banner state machine for SettingsPage.
 *
 * Params ({@link UseSettingsApplyArgs}):
 * - `settings` — from {@link useSettings}: source of truth for effective
 *   values and the apply/refresh APIs.
 * - `impact`   — from {@link useImpact}: refreshed after a successful apply.
 * - `dialog`   — modal API used for privacy confirm / revision / rate-limit
 *   alerts.
 *
 * Caching / loading / error semantics:
 * - No network cache of its own — all HTTP state lives in `settings` /
 *   `impact`. This hook only holds local UI state (draft, errors, banner).
 * - `submitting` gates the Apply button and reflects in-flight apply calls
 *   only (not background polling).
 * - Errors are consumed internally: validation becomes `validationErrors`,
 *   everything else is surfaced via dialogs. The hook never re-throws.
 */

export function useSettingsApply({
  settings,
  impact,
  dialog,
}: UseSettingsApplyArgs): UseSettingsApplyResult {
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [validationErrors, setValidationErrors] = useState<Array<{ key: string; reason: string }>>(
    [],
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResultPayloadView | null>(null);

  // Seed draft from effective values exactly once — after the first
  // successful fetch. Subsequent effective changes (from polling) are
  // intentionally ignored so that a background refetch does not clobber
  // the operator's in-flight edits. `discardDraft()` re-empties the map
  // and this effect re-seeds it on the next render.
  useEffect(() => {
    if (settings.effective && Object.keys(draft).length === 0) {
      setDraft(settings.effective.values as Record<string, DraftValue>);
    }
  }, [settings.effective, draft]);

  // Dirty = draft key whose value differs from effective. Identity
  // comparison is intentional — tunable values are primitives / strings.
  const dirtyKeys = useMemo(() => {
    if (!settings.effective) return [];
    return Object.keys(draft).filter((k) => draft[k] !== settings.effective!.values[k]);
  }, [draft, settings.effective]);

  // Recursive submit helper. Defined via named function expression so it
  // can re-invoke itself (see the privacy-confirm branch below) without
  // depending on a not-yet-defined const. The outer `apply` is a thin
  // wrapper that calls this with default opts.
  const doApply = useCallback(
    async function doApply(opts: { confirmPrivacy?: boolean } = {}): Promise<void> {
      if (!dirtyKeys.length || !settings.effective) return;
      // Build two parallel maps:
      //   - `diff`: wire payload sent to POST /api/settings/apply.
      //   - `beforeAfter`: UI-only record, used for the console log group
      //     and the success banner's diff table.
      const diff: Record<string, DraftValue> = {};
      const beforeAfter: Record<string, { before: DraftValue; after: DraftValue }> = {};
      for (const k of dirtyKeys) {
        const v = draft[k];
        if (v !== undefined) {
          diff[k] = v;
          beforeAfter[k] = {
            before: settings.effective.values[k] as DraftValue,
            after: v,
          };
        }
      }

      console.groupCollapsed(`[settings] apply → ${Object.keys(diff).length} key(s)`);

      console.table(beforeAfter);

      console.groupEnd();
      setSubmitting(true);
      setValidationErrors([]);
      setWarnings([]);
      try {
        const res: ApplyResultPayload = await settings.apply(diff, {
          confirm_privacy_change: !!opts.confirmPrivacy,
        });
        setWarnings(res.warnings || []);
        setApplyResult({
          kind: "apply",
          diff: beforeAfter,
          applied_now: res.applied_now || [],
          pending_restart: res.pending_restart || [],
          audit_id: res.audit_id ?? null,
        });

        console.info("[settings] apply ok", {
          applied_now: res.applied_now,
          pending_restart: res.pending_restart,
          audit_id: res.audit_id,
          warnings: res.warnings,
        });
        setDraft({});
        void impact.refresh();
      } catch (exc) {
        console.warn("[settings] apply failed", exc);
        const kind = classifyApplyError(exc);
        // 422 — surface per-key reasons in the page, no dialog.
        if (kind === "validation") {
          setValidationErrors(extractValidationErrors(exc) ?? []);
          return;
        }
        // 400 privacy_confirm_required — ask the operator and re-submit
        // with `confirmPrivacy: true` if they agree. Bailing out otherwise
        // keeps the draft intact so they can undo the ALPR toggle.
        if (kind === "privacy_confirm") {
          const confirmed = await dialog.confirm({
            title: "Privacy-sensitive change",
            message:
              "This change touches a privacy-sensitive setting (ALPR_MODE). " +
              "Toggling License Plate Recognition changes what data leaves the edge — confirm to proceed.",
            okLabel: "Apply with privacy change",
            variant: "warning",
          });
          if (confirmed) {
            await doApply({ confirmPrivacy: true });
          }
          return;
        }
        // 409 — someone else applied while we were editing. Discard draft
        // and refresh so the operator restarts from the new baseline.
        if (kind === "revision_conflict") {
          await dialog.alert({
            title: "Settings changed elsewhere",
            message:
              "Another operator (or another tab) updated the settings since you opened this page. Refreshing the view now.",
            variant: "warning",
          });
          await settings.refresh();
          setDraft({});
          return;
        }
        // 429 — server-side cooldown; keep draft, prompt to retry later.
        if (kind === "rate_limited") {
          await dialog.alert({
            title: "Apply rate-limited",
            message: "Too many applies in quick succession. Wait a few seconds and try again.",
            variant: "warning",
          });
          return;
        }

        console.error(exc);
        await dialog.alert({
          title: "Apply failed",
          message: (exc as Error).message,
          variant: "danger",
        });
      } finally {
        setSubmitting(false);
      }
    },
    [dirtyKeys, draft, settings, impact, dialog],
  );

  const apply = useCallback(async () => {
    await doApply();
  }, [doApply]);

  const discardDraft = useCallback(() => setDraft({}), []);
  const dismissApplyResult = useCallback(() => setApplyResult(null), []);

  return {
    draft,
    setDraft,
    dirtyKeys,
    validationErrors,
    warnings,
    applyResult,
    submitting,
    apply,
    discardDraft,
    dismissApplyResult,
  };
}
