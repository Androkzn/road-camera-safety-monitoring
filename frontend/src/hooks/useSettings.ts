/**
 * useSettings — fetches the schema + effective values, exposes apply / rollback.
 *
 * - Polls `/api/settings/effective` every 15 s while the page is mounted.
 * - Fetches `/api/settings/schema` once.
 * - Surfaces the `revision_hash` so the apply call can supply `If-Match`.
 * - Wraps apply in optimistic update + rollback-on-error so slider drags
 *   feel responsive without sacrificing correctness.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { adminFetch, clearAdminToken, MissingAdminTokenError } from "../lib/adminApi";
import type {
  ApplyResultPayload,
  EffectiveSettings,
  SettingsSchema,
} from "../types";

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
  apply: (
    diff: Record<string, unknown>,
    opts?: ApplyOptions,
  ) => Promise<ApplyResultPayload>;
  rollback: () => Promise<ApplyResultPayload>;
  validate: (diff: Record<string, unknown>) => Promise<unknown>;
}

const POLL_MS = 15_000;

export function useSettings(token: string | null): SettingsState {
  const [schema, setSchema] = useState<SettingsSchema | null>(null);
  const [effective, setEffective] = useState<EffectiveSettings | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState<boolean>(!token);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!token) {
      setNeedsToken(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [s, e] = await Promise.all([
        schema ? Promise.resolve(schema) : adminFetch<SettingsSchema>("/api/settings/schema"),
        adminFetch<EffectiveSettings>("/api/settings/effective"),
      ]);
      if (!mountedRef.current) return;
      setSchema(s);
      setEffective(e);
      setNeedsToken(false);
    } catch (exc) {
      if (exc instanceof MissingAdminTokenError) {
        setNeedsToken(true);
      } else if (exc instanceof Error) {
        const status = (exc as { status?: number }).status;
        if (status === 401 || status === 403 || status === 503) {
          // Cached token is bad / missing / server-disabled — drop it and
          // surface the prompt instead of polling forever in the background.
          clearAdminToken();
          setNeedsToken(true);
          setError(
            status === 403
              ? "Admin token rejected (HTTP 403). Paste the correct ROAD_ADMIN_TOKEN."
              : status === 503
                ? "Server has no admin token configured (HTTP 503)."
                : "Authentication required (HTTP 401).",
          );
        } else {
          setError(exc.message);
        }
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [schema, token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh, token]);

  const validate = useCallback(async (diff: Record<string, unknown>) => {
    return adminFetch<unknown>("/api/settings/validate", {
      method: "POST",
      body: JSON.stringify({ diff }),
    });
  }, []);

  const apply = useCallback(
    async (diff: Record<string, unknown>, opts: ApplyOptions = {}) => {
      const body = {
        diff,
        expected_revision_hash: opts.expected_revision_hash ?? effective?.revision_hash,
        confirm_privacy_change: !!opts.confirm_privacy_change,
        operator_label: opts.operator_label ?? null,
        note: opts.note ?? null,
      };
      const result = await adminFetch<ApplyResultPayload>("/api/settings/apply", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refresh();
      return result;
    },
    [effective, refresh],
  );

  const rollback = useCallback(async () => {
    const result = await adminFetch<ApplyResultPayload>("/api/settings/rollback", {
      method: "POST",
    });
    await refresh();
    return result;
  }, [refresh]);

  return {
    schema,
    effective,
    loading,
    error,
    needsToken,
    refresh,
    apply,
    rollback,
    validate,
  };
}
