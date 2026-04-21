/**
 * Settings API — `/api/settings/*` (POC: unauthenticated).
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: No direct UI — wraps the settings endpoints used across the
 *   SettingsPage (schema fetch, current values, validate, apply, impact).
 * Backend: GET /api/settings/schema, GET /api/settings/effective,
 *   POST /api/settings/validate, POST /api/settings/apply,
 *   GET /api/settings/impact.
 */
import { apiFetch } from "../../shared/lib/fetchClient";

import type {
  ApplyResultPayload,
  EffectiveSettings,
  ImpactReport,
  SettingsSchema,
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

  getImpact: (opts: RequestOptions = {}) =>
    apiFetch<ImpactResponse>("/api/settings/impact", { signal: opts.signal }),
};

export const settingsQueryKeys = {
  schema: ["settings", "schema"] as const,
  effective: ["settings", "effective"] as const,
  impact: ["settings", "impact"] as const,
};
