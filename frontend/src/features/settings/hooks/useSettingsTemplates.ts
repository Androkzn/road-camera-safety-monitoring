/**
 * useSettingsTemplates — list/create/delete/apply settings templates.
 */
import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  clearAdminToken,
  isAdminAuthFailure,
  MissingAdminTokenError,
} from "../../../shared/lib/adminApi";

import { settingsApi, settingsQueryKeys } from "../api";
import type { ApplyResultPayload, SettingsTemplate } from "../types";

export interface SettingsTemplatesState {
  templates: SettingsTemplate[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (
    name: string,
    description: string,
    payload: Record<string, unknown>,
  ) => Promise<SettingsTemplate>;
  remove: (id: string) => Promise<void>;
  applyTemplate: (
    id: string,
    opts?: { confirm_privacy_change?: boolean },
  ) => Promise<ApplyResultPayload>;
}

export function useSettingsTemplates(token: string | null): SettingsTemplatesState {
  const qc = useQueryClient();

  const templatesQuery = useQuery({
    queryKey: settingsQueryKeys.templates,
    queryFn: ({ signal }) => settingsApi.listTemplates({ signal }),
    enabled: !!token,
    retry: (_count, err) => !(err instanceof MissingAdminTokenError) && !isAdminAuthFailure(err),
  });

  useEffect(() => {
    if (templatesQuery.error && isAdminAuthFailure(templatesQuery.error)) {
      clearAdminToken();
    }
  }, [templatesQuery.error]);

  const invalidateTemplates = () => qc.invalidateQueries({ queryKey: settingsQueryKeys.templates });

  const createMutation = useMutation({
    mutationFn: ({
      name,
      description,
      payload,
    }: {
      name: string;
      description: string;
      payload: Record<string, unknown>;
    }) => settingsApi.createTemplate(name, description, payload),
    onSuccess: () => {
      void invalidateTemplates();
    },
    onError: (exc) => {
      if (isAdminAuthFailure(exc)) clearAdminToken();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => settingsApi.deleteTemplate(id),
    onSuccess: () => {
      void invalidateTemplates();
    },
    onError: (exc) => {
      if (isAdminAuthFailure(exc)) clearAdminToken();
    },
  });

  const applyTemplateMutation = useMutation({
    mutationFn: ({ id, opts }: { id: string; opts?: { confirm_privacy_change?: boolean } }) =>
      settingsApi.applyTemplate(id, opts),
    onSuccess: () => {
      // Template application mutates both the template metadata access path
      // and the effective settings snapshot displayed on this page.
      void Promise.all([
        invalidateTemplates(),
        qc.invalidateQueries({ queryKey: settingsQueryKeys.effective }),
      ]);
    },
    onError: (exc) => {
      if (isAdminAuthFailure(exc)) clearAdminToken();
    },
  });

  const refresh = useCallback(async () => {
    if (!token) return;
    await templatesQuery.refetch();
  }, [token, templatesQuery]);

  const create = useCallback(
    async (name: string, description: string, payload: Record<string, unknown>) => {
      return createMutation.mutateAsync({ name, description, payload });
    },
    [createMutation],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeMutation.mutateAsync(id);
    },
    [removeMutation],
  );

  const applyTemplate = useCallback(
    async (id: string, opts: { confirm_privacy_change?: boolean } = {}) => {
      return applyTemplateMutation.mutateAsync({ id, opts });
    },
    [applyTemplateMutation],
  );

  const error =
    templatesQuery.error instanceof MissingAdminTokenError
      ? null
      : templatesQuery.error instanceof Error
        ? templatesQuery.error.message
        : null;

  return {
    templates: token ? (templatesQuery.data?.templates ?? []) : [],
    loading:
      !!token &&
      (templatesQuery.isFetching ||
        createMutation.isPending ||
        removeMutation.isPending ||
        applyTemplateMutation.isPending),
    error: token ? error : null,
    refresh,
    create,
    remove,
    applyTemplate,
  };
}
