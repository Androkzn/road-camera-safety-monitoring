/**
 * Settings API — `/api/settings/*` (POC: unauthenticated).
 */
import { apiFetch } from "../../shared/lib/fetchClient";

import type {
  ApplyResultPayload,
  EffectiveSettings,
  ImpactReport,
  SettingsSchema,
  SettingsTemplate,
} from "./types";

interface ApplyOptions {
  expected_revision_hash?: string;
  confirm_privacy_change?: boolean;
  operator_label?: string | null;
  note?: string | null;
}

interface ImpactResponse {
  report: ImpactReport | null;
}

interface TemplatesResponse {
  templates: SettingsTemplate[];
}

interface RequestOptions {
  signal?: AbortSignal;
}

export const settingsApi = {
  getSchema: (opts: RequestOptions = {}) =>
    apiFetch<SettingsSchema>("/api/settings/schema", { signal: opts.signal }),
  getEffective: (opts: RequestOptions = {}) =>
    apiFetch<EffectiveSettings>("/api/settings/effective", {
      signal: opts.signal,
    }),

  validate: (diff: Record<string, unknown>) =>
    apiFetch<unknown>("/api/settings/validate", {
      method: "POST",
      body: JSON.stringify({ diff }),
    }),

  apply: (diff: Record<string, unknown>, opts: ApplyOptions = {}) =>
    apiFetch<ApplyResultPayload>("/api/settings/apply", {
      method: "POST",
      body: JSON.stringify({
        diff,
        expected_revision_hash: opts.expected_revision_hash,
        confirm_privacy_change: !!opts.confirm_privacy_change,
        operator_label: opts.operator_label ?? null,
        note: opts.note ?? null,
      }),
    }),

  captureBaseline: () =>
    apiFetch<{ ok: boolean; audit_id: string }>("/api/settings/baseline/capture", {
      method: "POST",
    }),

  getImpact: (opts: RequestOptions = {}) =>
    apiFetch<ImpactResponse>("/api/settings/impact", { signal: opts.signal }),

  listTemplates: (opts: RequestOptions = {}) =>
    apiFetch<TemplatesResponse>("/api/settings/templates", {
      signal: opts.signal,
    }),

  createTemplate: (name: string, description: string, payload: Record<string, unknown>) =>
    apiFetch<SettingsTemplate>("/api/settings/templates", {
      method: "POST",
      body: JSON.stringify({ name, description, payload }),
    }),

  deleteTemplate: (id: string) =>
    apiFetch<unknown>(`/api/settings/templates/${id}`, { method: "DELETE" }),

  applyTemplate: (id: string, opts: { confirm_privacy_change?: boolean } = {}) =>
    apiFetch<ApplyResultPayload>(`/api/settings/templates/${id}/apply`, {
      method: "POST",
      body: JSON.stringify({
        confirm_privacy_change: !!opts.confirm_privacy_change,
      }),
    }),
};

export const settingsQueryKeys = {
  schema: ["settings", "schema"] as const,
  effective: ["settings", "effective"] as const,
  impact: ["settings", "impact"] as const,
  templates: ["settings", "templates"] as const,
};
