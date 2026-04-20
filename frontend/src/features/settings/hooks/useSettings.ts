/**
 * useSettings — fetches schema + effective values, exposes apply / rollback.
 *
 * Both endpoints are admin-bearer; we route them via TanStack Query so
 * the cache + dedup works as for any other feature, and so a background
 * Settings tab stops issuing `/api/settings/*` requests
 * (`refetchIntervalInBackground: false`). The pre-D2.B version used a
 * hand-rolled `setInterval` that fired on backgrounded tabs.
 *
 * The "needs token" empty-state and admin-auth drop-on-failure behaviour
 * are derived from the query error via `MissingAdminTokenError` /
 * `isAdminAuthFailure` so the existing SettingsPage UI keeps working.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  clearAdminToken,
  isAdminAuthFailure,
  MissingAdminTokenError,
  type AdminApiError,
} from "../../../shared/lib/adminApi";
import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";

import { settingsApi, settingsQueryKeys } from "../api";
import type { ApplyResultPayload, EffectiveSettings, SettingsSchema } from "../types";

interface ApplyOptions {
  expected_revision_hash?: string;
  confirm_privacy_change?: boolean;
  operator_label?: string;
  note?: string;
}

export interface SettingsState {
  schema: SettingsSchema | null;
  effective: EffectiveSettings | null;
  loading: boolean;
  error: string | null;
  needsToken: boolean;
  refresh: () => Promise<void>;
  apply: (diff: Record<string, unknown>, opts?: ApplyOptions) => Promise<ApplyResultPayload>;
  rollback: () => Promise<ApplyResultPayload>;
  validate: (diff: Record<string, unknown>) => Promise<unknown>;
}

function classifyError(exc: unknown): {
  message: string | null;
  needsToken: boolean;
} {
  if (exc instanceof MissingAdminTokenError) {
    return { message: null, needsToken: true };
  }
  if (exc instanceof Error && isAdminAuthFailure(exc)) {
    const status = (exc as AdminApiError).status;
    return {
      message:
        status === 403
          ? "Admin token rejected (HTTP 403). Paste the correct ROAD_ADMIN_TOKEN."
          : status === 503
            ? "Server has no admin token configured (HTTP 503)."
            : "Authentication required (HTTP 401).",
      needsToken: true,
    };
  }
  if (exc instanceof Error) return { message: exc.message, needsToken: false };
  return { message: null, needsToken: !exc };
}

export function useSettings(token: string | null): SettingsState {
  const qc = useQueryClient();

  // Schema is stable for the life of the server process — no interval.
  const schemaQuery = useQuery({
    queryKey: settingsQueryKeys.schema,
    queryFn: ({ signal }) => settingsApi.getSchema({ signal }),
    enabled: !!token,
    staleTime: Infinity,
    retry: (_count, err) => !(err instanceof MissingAdminTokenError) && !isAdminAuthFailure(err),
  });

  // Effective values drive the "live baseline" column and are what the
  // apply / rollback / validate flows re-read after success. Poll at 15 s
  // but pause on backgrounded tabs — the apply flow refetches explicitly
  // on return, so the tab-visible poll is a best-effort refresh only.
  const effectiveQuery = useQuery({
    queryKey: settingsQueryKeys.effective,
    queryFn: ({ signal }) => settingsApi.getEffective({ signal }),
    enabled: !!token,
    refetchInterval: POLL_INTERVAL_MS.settingsEffective,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: (_count, err) => !(err instanceof MissingAdminTokenError) && !isAdminAuthFailure(err),
  });

  // Drop the cached token as soon as either query reports an admin-auth
  // failure so the UI flips to the token prompt instead of silently
  // retrying. Previously this lived inside the setInterval callback;
  // doing it as an effect against the latest query error keeps the
  // behaviour even though the query layer itself does the polling.
  useEffect(() => {
    const err = effectiveQuery.error ?? schemaQuery.error;
    if (err && isAdminAuthFailure(err)) {
      clearAdminToken();
    }
  }, [effectiveQuery.error, schemaQuery.error]);

  const { message, needsToken } = useMemo(() => {
    if (!token) return { message: null, needsToken: true };
    const err = effectiveQuery.error ?? schemaQuery.error;
    return err ? classifyError(err) : { message: null, needsToken: false };
  }, [token, effectiveQuery.error, schemaQuery.error]);

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
      const result = await settingsApi.apply(diff, {
        expected_revision_hash: opts.expected_revision_hash ?? effective?.revision_hash,
        confirm_privacy_change: !!opts.confirm_privacy_change,
        operator_label: opts.operator_label ?? null,
        note: opts.note ?? null,
      });
      await effectiveQuery.refetch();
      // Invalidate the impact session so its card refreshes promptly.
      void qc.invalidateQueries({ queryKey: settingsQueryKeys.impact });
      return result;
    },
    [effective?.revision_hash, effectiveQuery, qc],
  );

  const rollback = useCallback(async () => {
    const result = await settingsApi.rollback();
    await effectiveQuery.refetch();
    void qc.invalidateQueries({ queryKey: settingsQueryKeys.impact });
    return result;
  }, [effectiveQuery, qc]);

  return {
    schema: schemaQuery.data ?? null,
    effective,
    loading: schemaQuery.isFetching || effectiveQuery.isFetching,
    error: message,
    needsToken,
    refresh,
    apply,
    rollback,
    validate,
  };
}
