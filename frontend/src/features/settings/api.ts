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

/** Extra fields POSTed to /api/settings/apply alongside the diff.
 *  `expected_revision_hash` enforces optimistic concurrency (server rejects
 *  if the effective revision has moved since the draft was seeded).
 *  `confirm_privacy_change` gates tunables marked `requires_privacy_confirm`
 *  (e.g. ALPR_MODE) — the UI pops a dialog and sets this on the retry. */
interface ApplyOptions {
  expected_revision_hash?: string;
  confirm_privacy_change?: boolean;
  operator_label?: string | null;
  note?: string | null;
}

/** Wire shape for GET /api/settings/impact. `report` is null during the
 *  "no baseline yet" bootstrap window. */
interface ImpactResponse {
  report: ImpactReport | null;
}

/** Abort-signal plumbing so hooks can cancel in-flight GETs on unmount. */
interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * settingsApi — thin wrappers around /api/settings/*.
 *
 * UI connections: consumed by useSettings (schema+effective), useSettingsApply
 *   (validate+apply), and useImpact (dry-run preview). Not called directly
 *   from components.
 * BE endpoints:
 *   - GET /api/settings/schema — tunable specs (min/max/step/enum/mutability).
 *   - GET /api/settings/effective — current values + revision hash.
 *   - POST /api/settings/validate — dry-run a diff; returns per-key errors.
 *   - POST /api/settings/apply — commit the diff; returns ApplyResultPayload.
 *   - GET /api/settings/impact — before/after window stats for ImpactCard.
 */
export const settingsApi = {
  getSchema: (opts: RequestOptions = {}) =>
    apiFetch<SettingsSchema>("/api/settings/schema", { signal: opts.signal }),
  getEffective: (opts: RequestOptions = {}) =>
    apiFetch<EffectiveSettings>("/api/settings/effective", {
      signal: opts.signal,
    }),

  // No-commit dry-run: server returns the same shape as apply's 422 body.
  validate: (diff: Record<string, unknown>) =>
    apiFetch<unknown>("/api/settings/validate", {
      method: "POST",
      body: JSON.stringify({ diff }),
    }),

  // Coerces flag to a strict boolean and normalises optional string fields
  // to `null` so the server never sees `undefined` serialised away.
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

/**
 * settingsQueryKeys — stable TanStack Query cache keys for the settings
 * endpoints. Used by hooks to read/invalidate cache entries.
 */
export const settingsQueryKeys = {
  schema: ["settings", "schema"] as const,
  effective: ["settings", "effective"] as const,
  impact: ["settings", "impact"] as const,
};
