/**
 * useSettingsTemplates — list templates and apply them via the admin API.
 */

import { useCallback, useEffect, useState } from "react";

import { adminFetch, type AdminApiError, clearAdminToken } from "../lib/adminApi";
import type { ApplyResultPayload, SettingsTemplate } from "../types";

interface ListResponse {
  templates: SettingsTemplate[];
}

export function useSettingsTemplates(token: string | null): {
  templates: SettingsTemplate[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name: string, description: string, payload: Record<string, unknown>) => Promise<SettingsTemplate>;
  remove: (id: string) => Promise<void>;
  applyTemplate: (id: string, opts?: { confirm_privacy_change?: boolean }) => Promise<ApplyResultPayload>;
} {
  const [templates, setTemplates] = useState<SettingsTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<ListResponse>("/api/settings/templates");
      setTemplates(data.templates);
    } catch (exc) {
      const status = (exc as AdminApiError | undefined)?.status;
      if (status === 401 || status === 403 || status === 503) {
        clearAdminToken();
      }
      if (exc instanceof Error) setError(exc.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string, description: string, payload: Record<string, unknown>) => {
      const tmpl = await adminFetch<SettingsTemplate>("/api/settings/templates", {
        method: "POST",
        body: JSON.stringify({ name, description, payload }),
      });
      await refresh();
      return tmpl;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await adminFetch(`/api/settings/templates/${id}`, { method: "DELETE" });
      await refresh();
    },
    [refresh],
  );

  const applyTemplate = useCallback(
    async (id: string, opts: { confirm_privacy_change?: boolean } = {}) => {
      const result = await adminFetch<ApplyResultPayload>(
        `/api/settings/templates/${id}/apply`,
        {
          method: "POST",
          body: JSON.stringify({
            confirm_privacy_change: !!opts.confirm_privacy_change,
          }),
        },
      );
      await refresh();
      return result;
    },
    [refresh],
  );

  return { templates, loading, error, refresh, create, remove, applyTemplate };
}
