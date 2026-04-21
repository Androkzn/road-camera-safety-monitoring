/**
 * useSettings — fetches schema + effective values, exposes apply / validate.
 *
 * Backbone hook for the Settings console. Combines two queries (the static
 * schema of tunables and the live "effective" values currently in force)
 * and exposes write helpers (`apply`, `validate`) that forward to the
 * settings router. Both reads are polled via TanStack Query with
 * `refetchIntervalInBackground: false` so background tabs stay quiet.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: Provides the schema and current values that populate every
 *   tunable row in the left column of the SettingsPage.
 * Backend: GET /api/settings/schema, GET /api/settings/effective,
 *   POST /api/settings/apply, POST /api/settings/validate.
 * Consumers: `SettingsPage` (reads schema + effective; wires `apply` to
 *   the header) and `useSettingsApply` (composes on top to own the draft
 *   lifecycle).
 */
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";

import { settingsApi, settingsQueryKeys } from "../api";
import type { ApplyResultPayload, EffectiveSettings, SettingsSchema } from "../types";

/**
 * Options that customize a single `apply()` call.
 *
 * - `expected_revision_hash` — optimistic-concurrency token; the server
 *   rejects with 409 if the effective revision has moved since this
 *   hash was observed. Defaults to the currently cached effective hash.
 * - `confirm_privacy_change` — must be `true` to apply a diff touching a
 *   privacy-sensitive tunable (e.g. ALPR_MODE); otherwise the server
 *   returns 400 / `privacy_confirm_required`.
 * - `operator_label` / `note` — audit-log annotations stored alongside
 *   the change.
 */
interface ApplyOptions {
  expected_revision_hash?: string;
  confirm_privacy_change?: boolean;
  operator_label?: string | null;
  note?: string | null;
}

/**
 * Public return shape of {@link useSettings}.
 *
 * - `schema` / `effective` are `null` until the initial fetch settles.
 * - `loading` is true while either query is in flight (initial or refetch).
 * - `error` is a flattened message picked from whichever query failed first
 *   (effective takes priority because it's what drives the page).
 * - `refresh`  — manually refetches both queries in parallel.
 * - `apply`    — POSTs a settings diff; on success refreshes `effective`
 *   and invalidates the `impact` query so the preview re-baselines.
 * - `validate` — dry-run a diff without persisting.
 */
export interface SettingsState {
  schema: SettingsSchema | null;
  effective: EffectiveSettings | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  apply: (diff: Record<string, unknown>, opts?: ApplyOptions) => Promise<ApplyResultPayload>;
  validate: (diff: Record<string, unknown>) => Promise<unknown>;
}

// Flatten an unknown thrown value into a UI-renderable string. Only `Error`
// instances are unwrapped; anything else collapses to `null` so the page
// falls back to a generic empty state instead of printing `[object Object]`.
function errorMessage(exc: unknown): string | null {
  if (exc instanceof Error) return exc.message;
  return null;
}

/**
 * Load the Settings schema + effective values and expose write helpers.
 *
 * No params. Returns a {@link SettingsState}.
 *
 * Caching / loading / error semantics:
 * - `schema` uses `staleTime: Infinity` — the tunable schema is considered
 *   static for the app's lifetime; a reload is the only way to refresh it.
 * - `effective` polls every `POLL_INTERVAL_MS.settingsEffective` (paused in
 *   background tabs, refetched on window focus) so the UI picks up
 *   out-of-band changes from other operators.
 * - `loading` is OR'd across both queries' `isFetching`, so it ticks true
 *   during polls too — callers that only care about the first load should
 *   also check `schema == null || effective == null`.
 * - `apply` reuses `effective?.revision_hash` as the default concurrency
 *   token, so callers get optimistic-concurrency for free without having
 *   to thread the hash through themselves.
 */
export function useSettings(): SettingsState {
  const qc = useQueryClient();

  // Schema is immutable at runtime (shape of tunables), so never stale.
  const schemaQuery = useQuery({
    queryKey: settingsQueryKeys.schema,
    queryFn: ({ signal }) => settingsApi.getSchema({ signal }),
    staleTime: Infinity,
  });

  // Effective values DO drift (another operator / another tab can apply),
  // so poll them while the tab is focused.
  const effectiveQuery = useQuery({
    queryKey: settingsQueryKeys.effective,
    queryFn: ({ signal }) => settingsApi.getEffective({ signal }),
    refetchInterval: POLL_INTERVAL_MS.settingsEffective,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  // Prefer the effective-query error because it's the one driving the page;
  // fall back to the schema error only if that's the only one present.
  const message = useMemo(() => {
    const err = effectiveQuery.error ?? schemaQuery.error;
    return err ? errorMessage(err) : null;
  }, [effectiveQuery.error, schemaQuery.error]);

  const refresh = useCallback(async () => {
    await Promise.all([schemaQuery.refetch(), effectiveQuery.refetch()]);
  }, [schemaQuery, effectiveQuery]);

  const validate = useCallback(
    async (diff: Record<string, unknown>) => settingsApi.validate(diff),
    [],
  );

  const effective = effectiveQuery.data ?? null;

  const apply = useCallback(
    async (diff: Record<string, unknown>, opts: ApplyOptions = {}) => {
      // Fill in the concurrency token from the last-known effective snapshot
      // unless the caller overrode it. `confirm_privacy_change` is coerced
      // to a strict boolean so `undefined` never gets sent on the wire.
      const result = await settingsApi.apply(diff, {
        expected_revision_hash: opts.expected_revision_hash ?? effective?.revision_hash,
        confirm_privacy_change: !!opts.confirm_privacy_change,
        operator_label: opts.operator_label ?? null,
        note: opts.note ?? null,
      });
      // Refresh local state to match the server's post-apply world and
      // invalidate the impact preview so the next render re-baselines.
      await effectiveQuery.refetch();
      void qc.invalidateQueries({ queryKey: settingsQueryKeys.impact });
      return result;
    },
    [effective?.revision_hash, effectiveQuery, qc],
  );

  return {
    schema: schemaQuery.data ?? null,
    effective,
    loading: schemaQuery.isFetching || effectiveQuery.isFetching,
    error: message,
    refresh,
    apply,
    validate,
  };
}
