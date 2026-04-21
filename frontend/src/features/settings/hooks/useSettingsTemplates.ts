/**
 * useSettingsTemplates — list/create/delete/apply settings templates.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

export function useSettingsTemplates(): SettingsTemplatesState {
  const qc = useQueryClient();

  const templatesQuery = useQuery({
    queryKey: settingsQueryKeys.templates,
    queryFn: ({ signal }) => settingsApi.listTemplates({ signal }),
  });

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
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => settingsApi.deleteTemplate(id),
    onSuccess: () => {
      void invalidateTemplates();
    },
  });

  const applyTemplateMutation = useMutation({
    mutationFn: ({ id, opts }: { id: string; opts?: { confirm_privacy_change?: boolean } }) =>
      settingsApi.applyTemplate(id, opts),
    onSuccess: () => {
      void Promise.all([
        invalidateTemplates(),
        qc.invalidateQueries({ queryKey: settingsQueryKeys.effective }),
      ]);
    },
  });

  const refresh = useCallback(async () => {
    await templatesQuery.refetch();
  }, [templatesQuery]);

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
    templatesQuery.error instanceof Error ? templatesQuery.error.message : null;

  return {
    templates: templatesQuery.data?.templates ?? [],
    loading:
      templatesQuery.isFetching ||
      createMutation.isPending ||
      removeMutation.isPending ||
      applyTemplateMutation.isPending,
    error,
    refresh,
    create,
    remove,
    applyTemplate,
  };
}
