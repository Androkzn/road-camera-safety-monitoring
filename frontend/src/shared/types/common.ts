/**
 * Shared TypeScript types — cross-feature backend contracts.
 *
 * This module re-exports the types produced from the pydantic models in
 * ``backend/api/models.py`` by ``scripts/generate_ts_types.py``. It
 * exists purely for backward compatibility — every existing import of
 * ``"shared/types/common"`` in the codebase keeps working.
 *
 * **Source of truth**: the backend. To change a wire format, edit a
 * pydantic model in ``backend/api/models.py``, run
 * ``python scripts/generate_ts_types.py`` (or just run ``python start.py``
 * which does it for you), and the types propagate here automatically.
 *
 * **Do not hand-add fields to this file** — they'll silently disagree
 * with what the backend actually emits. If you need a frontend-only
 * helper type that isn't on the wire, put it in the consuming feature
 * folder (``features/<name>/types.ts``).
 */

// `export type` / `export interface` re-exports — TS erases these at
// build time; `verbatimModuleSyntax` in tsconfig means we have to say
// `export type` explicitly for types (there is no runtime code here).
export type {
  DetectionObject,
  DetectionSnapshot,
  DriftReport,
  EgoFlow,
  Enrichment,
  HealthData,
  LiveSourceStatus,
  LiveSourcesResponse,
  LiveStatus,
  PerceptionState,
  PerceptionStateMessage,
  SafetyEvent,
  SceneContext,
  TestResult,
  TestStatus,
  WatchdogEvidence,
  WatchdogFinding,
  WatchdogStatus,
  WatchdogTopIncident,
} from "./generated";
