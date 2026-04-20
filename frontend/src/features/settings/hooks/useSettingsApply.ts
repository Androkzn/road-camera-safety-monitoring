/**
 * useSettingsApply — owns the Settings Console draft lifecycle.
 *
 * Composes on top of `useSettings`, `useSettingsTemplates`, `useImpact`,
 * and turns them into a single page-shaped state object.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { HttpApiError } from "../../../shared/lib/fetchClient";
import type { DialogApi } from "../../../shared/ui";

import type { ApplyResultPayloadView } from "../components/ApplyResultBanner";
import { extractValidationErrors, isPrivacyConfirmRequired } from "../utils/validation";
import type { ApplyResultPayload, DraftValue } from "../types";

import type { SettingsState } from "./useSettings";
import type { SettingsTemplatesState } from "./useSettingsTemplates";
import type { ImpactState } from "./useImpact";

interface UseSettingsApplyArgs {
  settings: SettingsState;
  templates: SettingsTemplatesState;
  impact: ImpactState;
  dialog: DialogApi;
}

export type ApplyErrorKind =
  | "validation"
  | "privacy_confirm"
  | "revision_conflict"
  | "rate_limited"
  | "unknown";

export function classifyApplyError(exc: unknown): ApplyErrorKind {
  if (extractValidationErrors(exc)) return "validation";
  if (isPrivacyConfirmRequired(exc)) return "privacy_confirm";
  const status = (exc as Partial<HttpApiError>).status;
  if (status === 409) return "revision_conflict";
  if (status === 429) return "rate_limited";
  return "unknown";
}

export interface UseSettingsApplyResult {
  draft: Record<string, DraftValue>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, DraftValue>>>;
  dirtyKeys: string[];
  validationErrors: Array<{ key: string; reason: string }>;
  warnings: string[];
  applyResult: ApplyResultPayloadView | null;
  submitting: boolean;
  apply: () => Promise<void>;
  rollback: () => Promise<void>;
  applyTemplate: (id: string) => Promise<void>;
  discardDraft: () => void;
  dismissApplyResult: () => void;
}

export function useSettingsApply({
  settings,
  templates,
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

  useEffect(() => {
    if (settings.effective && Object.keys(draft).length === 0) {
      setDraft(settings.effective.values as Record<string, DraftValue>);
    }
  }, [settings.effective, draft]);

  const dirtyKeys = useMemo(() => {
    if (!settings.effective) return [];
    return Object.keys(draft).filter((k) => draft[k] !== settings.effective!.values[k]);
  }, [draft, settings.effective]);

  const doApply = useCallback(
    async function doApply(opts: { confirmPrivacy?: boolean } = {}): Promise<void> {
      if (!dirtyKeys.length || !settings.effective) return;
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
        if (kind === "validation") {
          setValidationErrors(extractValidationErrors(exc) ?? []);
          return;
        }
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

  const rollback = useCallback(async () => {
    const ok = await dialog.confirm({
      title: "Rollback to last-known-good",
      message:
        "Restore the snapshot that was active immediately before the most recent apply. " +
        "Subscribers (LLM bucket, track-history rebuild, etc.) will re-fire.",
      okLabel: "Rollback",
      variant: "danger",
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      const res = await settings.rollback();
      setWarnings(res.warnings || []);
      setApplyResult({
        kind: "rollback",
        diff: {},
        applied_now: res.applied_now || [],
        pending_restart: res.pending_restart || [],
        audit_id: res.audit_id ?? null,
      });

      console.info("[settings] rollback ok", {
        applied_now: res.applied_now,
        pending_restart: res.pending_restart,
      });
      setDraft({});
      await impact.refresh();
    } catch (exc) {
      await dialog.alert({
        title: "Rollback failed",
        message: (exc as Error).message,
        variant: "danger",
      });
    } finally {
      setSubmitting(false);
    }
  }, [settings, impact, dialog]);

  const applyTemplate = useCallback(
    async (id: string) => {
      setSubmitting(true);
      try {
        const res = await templates.applyTemplate(id);
        setWarnings(res.warnings || []);
        setApplyResult({
          kind: "template",
          diff: {},
          applied_now: res.applied_now || [],
          pending_restart: res.pending_restart || [],
          audit_id: res.audit_id ?? null,
        });

        console.info("[settings] template apply ok", {
          template_id: id,
          applied_now: res.applied_now,
          pending_restart: res.pending_restart,
        });
        setDraft({});
        await impact.refresh();
      } catch (exc) {
        if (isPrivacyConfirmRequired(exc)) {
          const confirmed = await dialog.confirm({
            title: "Template touches privacy setting",
            message:
              "This template changes a privacy-sensitive setting (ALPR_MODE). Confirm to proceed.",
            okLabel: "Apply template",
            variant: "warning",
          });
          if (confirmed) {
            await templates.applyTemplate(id, { confirm_privacy_change: true });
            await settings.refresh();
          }
          return;
        }
        await dialog.alert({
          title: "Apply template failed",
          message: (exc as Error).message,
          variant: "danger",
        });
      } finally {
        setSubmitting(false);
      }
    },
    [templates, settings, impact, dialog],
  );

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
    rollback,
    applyTemplate,
    discardDraft,
    dismissApplyResult,
  };
}
