/**
 * useValidator — polls /api/validator/status and exposes an enable/disable
 * mutator backed by /api/validator/toggle.
 *
 * Optimistic updates: the checkbox flips immediately on click, then the
 * mutator rewrites the cache with the server's response. If the request
 * fails we revert via query invalidation.
 */
// TanStack Query primitives:
//   useQuery         — declarative GET with caching + polling + dedupe.
//   useMutation      — declarative POST/PUT/DELETE with retries + lifecycle.
//   useQueryClient   — imperative handle to the shared cache.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { POLL_INTERVAL_MS, STALE_TIME_MS } from "../../../shared/config/runtime";
import { fetchJson, postJson } from "../../../shared/lib/fetchClient";

/**
 * Shape of `/api/validator/status` and `/api/validator/toggle` responses.
 * Most fields are optional because the backend omits them when the
 * validator is disabled at startup.
 */
export interface ValidatorStatusPayload {
  enabled: boolean;
  paused?: boolean;
  running?: boolean;
  backend?: string;
  model_path?: string;
  device?: string;
  queue_depth?: number;
  queue_max?: number;
  sample_sec?: number;
  iou_threshold?: number;
  jobs_processed?: number;
  jobs_dropped?: number;
  findings_emitted?: number;
  episodes_enqueued?: number;
  overflow_depth?: number;
}

// `as const` narrows the array type from `string[]` to a readonly tuple
// of string literals — required so TanStack's cache-key types work.
const VALIDATOR_QUERY_KEY = ["monitoring", "validator"] as const;

/**
 * Hook returning validator status + enable/disable mutator.
 *
 * @param refetchMs polling interval in ms; defaults to the shared constant.
 */
export function useValidator(refetchMs: number = POLL_INTERVAL_MS.validator) {
  const qc = useQueryClient();

  // GET /api/validator/status on an interval. `staleTime` tells the cache
  // when a value is considered "fresh enough" to skip a refetch.
  const status = useQuery<ValidatorStatusPayload>({
    queryKey: VALIDATOR_QUERY_KEY,
    queryFn: ({ signal }) => fetchJson<ValidatorStatusPayload>("/api/validator/status", { signal }),
    refetchInterval: refetchMs,
    staleTime: STALE_TIME_MS.validator,
  });

  // POST /api/validator/toggle with optimistic UI:
  //   1. `onMutate`  — immediately write the new state into the cache.
  //   2. `onError`   — roll back to the snapshot if the POST fails.
  //   3. `onSuccess` — overwrite with the server's authoritative response.
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      postJson<ValidatorStatusPayload, { enabled: boolean }>("/api/validator/toggle", { enabled }),
    onMutate: async (enabled) => {
      // Pause any in-flight refetches so they don't clobber our optimistic write.
      await qc.cancelQueries({ queryKey: VALIDATOR_QUERY_KEY });
      const previous = qc.getQueryData<ValidatorStatusPayload>(VALIDATOR_QUERY_KEY);
      if (previous) {
        // Spread `...previous` copies existing fields; then override `paused`.
        qc.setQueryData<ValidatorStatusPayload>(VALIDATOR_QUERY_KEY, {
          ...previous,
          paused: !enabled,
        });
      }
      // Returning context makes it available to onError as `ctx`.
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // Leading-underscore params tell the reader (and TS) they're intentionally unused.
      if (ctx?.previous) {
        qc.setQueryData(VALIDATOR_QUERY_KEY, ctx.previous);
      }
    },
    onSuccess: (payload) => {
      qc.setQueryData(VALIDATOR_QUERY_KEY, payload);
    },
  });

  return {
    status: status.data ?? null,
    isLoading: status.isLoading,
    error: status.error as Error | null,
    setEnabled: (enabled: boolean) => toggle.mutate(enabled),
    isPending: toggle.isPending,
  };
}
