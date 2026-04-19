/**
 * useLiveSources — polls `/api/live/sources` every `intervalMs` and exposes
 * `start(id)` / `pause(id)` mutators that hit the matching POST endpoints
 * and refresh the list on completion.
 *
 * Used by AdminPage's multi-source grid so each tile can render its own
 * Start / Pause button without coordinating refreshes manually.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { dialog } from "../components/ui/Dialog";
import { api } from "../lib/api";
import type { LiveSourceStatus, LiveSourcesResponse } from "../types";

export interface UseLiveSourcesResult {
  sources: LiveSourceStatus[];
  primaryId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  setDetection: (id: string, enabled: boolean) => Promise<void>;
  add: (input: { url: string; name?: string }) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: string) => Promise<void>;
  busyById: Record<string, boolean>;
}

export function useLiveSources(intervalMs = 5000): UseLiveSourcesResult {
  const [data, setData] = useState<LiveSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyById, setBusyById] = useState<Record<string, boolean>>({});
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getLiveSources();
      if (!mountedRef.current) return;
      setData(res);
      setError(null);
    } catch (exc) {
      if (!mountedRef.current) return;
      setError((exc as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [refresh, intervalMs]);

  const mark = useCallback((id: string, v: boolean) => {
    setBusyById((prev) => ({ ...prev, [id]: v }));
  }, []);

  // Safety belt: any slot stuck in the "busy" state for more than 8 s gets
  // force-cleared. Prevents the Start / Pause button from getting wedged on
  // "Pausing…" / "Starting…" if a request hangs (the request itself is
  // wrapped in try/finally so this is belt-and-braces, not strictly needed).
  useEffect(() => {
    const stuck = Object.entries(busyById).filter(([, v]) => v);
    if (stuck.length === 0) return;
    const t = window.setTimeout(() => {
      setBusyById((prev) => {
        const next: Record<string, boolean> = { ...prev };
        let changed = false;
        for (const [id] of stuck) {
          if (next[id]) {
            next[id] = false;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 8000);
    return () => window.clearTimeout(t);
  }, [busyById]);

  /** Optimistically flip a slot's ``running`` flag so the button label
   *  swaps immediately. The next ``refresh()`` reconciles authoritative
   *  state from the backend. */
  const setRunningOptimistic = useCallback((id: string, running: boolean) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            sources: prev.sources.map((s) =>
              s.id === id ? { ...s, running } : s,
            ),
          }
        : prev,
    );
  }, []);

  const start = useCallback(
    async (id: string) => {
      mark(id, true);
      setRunningOptimistic(id, true);
      try {
        await api.startLiveSource(id);
      } catch (exc) {
        // Roll back the optimistic flip and surface the failure.
        setRunningOptimistic(id, false);
        void dialog.alert({
          title: "Start stream failed",
          message: (exc as Error)?.message ?? "unknown error",
          variant: "danger",
        });
      } finally {
        mark(id, false);
        await refresh();
      }
    },
    [mark, refresh, setRunningOptimistic],
  );

  const pause = useCallback(
    async (id: string) => {
      mark(id, true);
      setRunningOptimistic(id, false);
      try {
        await api.pauseLiveSource(id);
      } catch (exc) {
        setRunningOptimistic(id, true);
        void dialog.alert({
          title: "Pause stream failed",
          message: (exc as Error)?.message ?? "unknown error",
          variant: "danger",
        });
      } finally {
        mark(id, false);
        await refresh();
      }
    },
    [mark, refresh, setRunningOptimistic],
  );

  const setDetection = useCallback(
    async (id: string, enabled: boolean) => {
      // Optimistic update so the checkbox flips immediately while the
      // POST is in flight; the next refresh reconciles authoritative state.
      setData((prev) =>
        prev
          ? {
              ...prev,
              sources: prev.sources.map((s) =>
                s.id === id ? { ...s, detection_enabled: enabled } : s,
              ),
            }
          : prev,
      );
      try {
        await api.setLiveSourceDetection(id, enabled);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const add = useCallback(
    async (input: { url: string; name?: string }) => {
      try {
        const res = await api.addLiveSource({ ...input, autostart: true });
        await refresh();
        return { ok: !!res.ok, error: res.error };
      } catch (exc) {
        await refresh();
        return { ok: false, error: (exc as Error).message };
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      mark(id, true);
      // Optimistic removal so the tile vanishes immediately.
      setData((prev) =>
        prev ? { ...prev, sources: prev.sources.filter((s) => s.id !== id) } : prev,
      );
      try {
        await api.removeLiveSource(id);
      } finally {
        mark(id, false);
        await refresh();
      }
    },
    [mark, refresh],
  );

  return {
    sources: data?.sources ?? [],
    primaryId: data?.primary_id ?? null,
    loading,
    error,
    refresh,
    start,
    pause,
    setDetection,
    add,
    remove,
    busyById,
  };
}
