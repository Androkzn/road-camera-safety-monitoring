/**
 * useSettingsApply — owns the Settings Console draft lifecycle.
 *
 * Composes on top of `useSettings` (queries + apply/rollback/validate
 * primitives), `useSettingsTemplates` (template mutations) and
 * `useImpact` (impact-card refresh after successful writes), and turns
 * them into a single page-shaped state object:
 *
 *   draft / setDraft        — pending edits, seeded from effective values
 *   dirtyKeys               — keys in draft that diverge from effective
 *   validationErrors        — 422 body from the server, rendered per key
 *   warnings                — apply / rollback / template soft warnings
 *   applyResult             — banner payload for the last success
 *   submitting              — any apply/rollback/template in flight
 *   apply()                 — runs apply + all error branches (privacy
 *                             confirm, 401/403 auth-drop via MissingAdminTokenError,
 *                             409 revision conflict, 429 rate limit)
 *   rollback()              — confirm + rollback + banner
 *   applyTemplate(id)       — template-apply with privacy-confirm retry
 *   discardDraft()          — drop pending edits
 *
 * This hook owns no JSX — the page still renders the dialogs, banners
 * and error lists. It is callable in unit tests by stubbing the two
 * injected state objects (`settings`, `templates`, `impact`) and the
 * `dialog` API.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type AdminApiError,
  MissingAdminTokenError,
} from "../../../shared/lib/adminApi";
import type { DialogApi } from "../../../shared/ui";

import type { ApplyResultPayloadView } from "../components/ApplyResultBanner";
import {
  extractValidationErrors,
  isPrivacyConfirmRequired,
} from "../utils/validation";
import type {
  ApplyResultPayload,
  DraftValue,
} from "../types";

import type { SettingsState } from "./useSettings";
import type { SettingsTemplatesState } from "./useSettingsTemplates";
import type { ImpactState } from "./useImpact";

interface UseSettingsApplyArgs {
  settings: SettingsState;
  templates: SettingsTemplatesState;
  impact: ImpactState;
  dialog: DialogApi;
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
  const [validationErrors, setValidationErrors] = useState<
    Array<{ key: string; reason: string }>
  >([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResultPayloadView | null>(
    null,
  );

  // Re-seed the draft from effective values whenever they appear and the
  // operator hasn't started editing.
  useEffect(() => {
    if (settings.effective && Object.keys(draft).length === 0) {
      setDraft(settings.effective.values as Record<string, DraftValue>);
    }
  }, [settings.effective, draft]);

  const dirtyKeys = useMemo(() => {
    if (!settings.effective) return [];
    return Object.keys(draft).filter(
      (k) => draft[k] !== settings.effective!.values[k],
    );
  }, [draft, settings.effective]);

  const doApply = useCallback(
    async function doApply(
      opts: { confirmPrivacy?: boolean } = {},
    ): Promise<void> {
      if (!dirtyKeys.length || !settings.effective) return;
      const diff: Record<string, DraftValue> = {};
      const beforeAfter: Record<
        string,
        { before: DraftValue; after: DraftValue }
      > = {};
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
      // Structured console log for operators tuning from DevTools.
      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `[settings] apply → ${Object.keys(diff).length} key(s)`,
      );
      // eslint-disable-next-line no-console
      console.table(beforeAfter);
      // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.info("[settings] apply ok", {
          applied_now: res.applied_now,
          pending_restart: res.pending_restart,
          audit_id: res.audit_id,
          warnings: res.warnings,
        });
        setDraft({});
        void impact.refresh();
      } catch (exc) {
        // eslint-disable-next-line no-console
        console.warn("[settings] apply failed", exc);
        const errors = extractValidationErrors(exc);
        if (errors) {
          setValidationErrors(errors);
          return;
        }
        if (isPrivacyConfirmRequired(exc)) {
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
        if (exc instanceof MissingAdminTokenError) return;
        const status = (exc as AdminApiError).status;
        if (status === 409) {
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
        if (status === 429) {
          await dialog.alert({
            title: "Apply rate-limited",
            message:
              "Too many applies in quick succession. Wait a few seconds and try again.",
            variant: "warning",
          });
          return;
        }
        // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
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
