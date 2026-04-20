/**
 * useSettings — fetches schema + effective values, exposes apply / rollback.
 *
 * Endpoints are polled via TanStack Query with
 * `refetchIntervalInBackground: false` so background tabs stay quiet.
 */
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { POLL_INTERVAL_MS } from "../../../shared/config/runtime";

import { settingsApi, settingsQueryKeys } from "../api";
import type { ApplyResultPayload, EffectiveSettings, SettingsSchema } from "../types";

interface ApplyOptions {
  expected_revision_hash?: string;
  confirm_privacy_change?: boolean;
  operator_label?: string | null;
  note?: string | null;
}

export interface SettingsState {
  schema: SettingsSchema | null;
  effective: EffectiveSettings | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  apply: (diff: Record<string, unknown>, opts?: ApplyOptions) => Promise<ApplyResultPayload>;
  rollback: () => Promise<ApplyResultPayload>;
  validate: (diff: Record<string, unknown>) => Promise<unknown>;
}

function errorMessage(exc: unknown): string | null {
  if (exc instanceof Error) return exc.message;
  return null;
}

export function useSettings(): SettingsState {
  const qc = useQueryClient();

  const schemaQuery = useQuery({
    queryKey: settingsQueryKeys.schema,
    queryFn: ({ signal }) => settingsApi.getSchema({ signal }),
    staleTime: Infinity,
  });

  const effectiveQuery = useQuery({
    queryKey: settingsQueryKeys.effective,
    queryFn: ({ signal }) => settingsApi.getEffective({ signal }),
    refetchInterval: POLL_INTERVAL_MS.settingsEffective,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

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
      const result = await settingsApi.apply(diff, {
        expected_revision_hash: opts.expected_revision_hash ?? effective?.revision_hash,
        confirm_privacy_change: !!opts.confirm_privacy_change,
        operator_label: opts.operator_label ?? null,
        note: opts.note ?? null,
      });
      await effectiveQuery.refetch();
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
    refresh,
    apply,
    rollback,
    validate,
  };
}
