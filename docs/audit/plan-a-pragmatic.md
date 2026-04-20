# Plan A — Pragmatic improvements

**Theme:** decompose the worst offenders, tighten the data layer.
**Horizon:** short — items are sized in days/weeks for one engineer.
**Read order:** [backend audit](backend.md) and [frontend audit](frontend.md) describe the findings; this doc is the action list.

Each work item carries:

- **Observed** — citation in the codebase (path + line range).
- **Why it matters** — concrete impact.
- **Options** — 2–4 ways to address.
- **Trade-offs** — what each option costs / gives up.
- **Recommended** — the option I would pick *for this codebase's stage*, with reason.
- **Effort** — S (≤ 1 day), M (1 week), L (≥ 1 sprint).
- **Risk** — low / medium / high.
- **Files touched** — concrete paths.
- **Depends on** — prerequisite items, if any.

> **Plan A is not a competitor to Plan B.** Plan A is the prerequisite. Several Plan B items become safe only once these have landed (and tests exist).

> **Per the project user rule:** lint / type-check / formatter changes are gated on explicit approval. The items below mention them; I will not actually run them without a green light.

> **What this plan does NOT claim.** No specific bundle-size or LOC-deletion numbers (nothing was measured). Route-level lazy loading and `<ErrorBoundary>` per route are **already** wired in [frontend/src/app/router.tsx](../../frontend/src/app/router.tsx) — not recommended as missing.

---

## A1. Decompose `SettingsPage.tsx` (god component)

**Observed.** [features/settings/SettingsPage.tsx](../../frontend/src/features/settings/SettingsPage.tsx) is 431 LOC. The header docstring brags it was previously 1,564 — good progress. Still owns 3 dialog flows (`doApply`, `doRollback`, `doApplyTemplate` — together ~190 LOC), draft + validation state, and 8 hooks.

**Why it matters.** This is the canonical "god component" smell in 2026 — it doesn't render 800 lines of JSX, it owns 300 lines of orchestration. Cost shows up in review time, test setup, and onboarding.

**Options.**
- **(a)** Light extraction: lift the 3 dialog flows into `useApplyFlow` / `useRollbackFlow` / `useTemplateFlow` hooks under `features/settings/hooks/`. Page shrinks ~150 LOC.
- **(b)** Also extract draft state into `useSettingsDraft` (`{ draft, setKey, dirtyKeys, errorByKey, reset }`) and move `extractValidationErrors` / `isPrivacyConfirmRequired` into the new hook's module.
- **(c)** Full split: page becomes a `<SettingsLayout>` ≤ 100 LOC; every section is its own subtree with its own hook.

**Trade-offs.**
- (a) one PR, low risk, marginal win.
- (b) doubles the win at moderate risk; the apply pipeline that already had one painful refactor needs care.
- (c) highest payoff but risks regressing apply/rollback orchestration without tests.

**Recommended.** **(b).** 80% of the value at 30% of the risk. (c) belongs in Plan B once Vitest is wired.

**Effort.** M (3–5 days). **Risk.** medium.

**Files touched.**
- New: `features/settings/hooks/useApplyFlow.ts`, `useRollbackFlow.ts`, `useTemplateFlow.ts`, `useSettingsDraft.ts`.
- Modified: `features/settings/SettingsPage.tsx`, `features/settings/utils/validation.ts`.
- Same PR (drive-by): pull `StreamTile` out of `features/admin/components/MultiSourceGrid.tsx` into its own file.

**Depends on.** None.

---

## A2. Migrate `useSettings` and `useImpact` from `setInterval` to `useQuery`

**Observed.** [features/settings/hooks/useSettings.ts:99–104](../../frontend/src/features/settings/hooks/useSettings.ts) uses raw `setInterval(refresh, 15_000)`. [features/settings/hooks/useImpact.ts:49](../../frontend/src/features/settings/hooks/useImpact.ts) — same pattern.

**Why it matters.** Doesn't pause on hidden tabs, doesn't dedup across consumers, doesn't cancel on unmount-during-flight, doesn't share cache. The rest of the FE uses TanStack Query and gets all of these for free; these two pay the cost without the upside.

**Options.**
- **(a)** Migrate both to `useQuery({ ..., refetchInterval: 15_000 })`.
- **(b)** Keep `setInterval` and add `document.visibilitychange` gating manually.
- **(c)** Leave.

**Trade-offs.** (a) consistent with the rest of the FE; eliminates a class of polling/cache/retry boilerplate; gets focus refetch + cancellation for free. (b) re-implements TanStack behaviour. (c) wastes background bandwidth.

**Recommended.** **(a).**

> **Scope reminder.** TanStack Query is for HTTP request/response. **Do not** fold SSE (`useSSE` / `useEventStream`) into TanStack Query — push streams are a different category. SSE stays on its own provider (item A3).

**Effort.** S (1 day). **Risk.** low.

**Files touched.** `features/settings/hooks/useSettings.ts`, `features/settings/hooks/useImpact.ts`.
**Drive-by:** delete `shared/hooks/usePolling.ts` (no consumers remain after this change).

**Depends on.** None.

---

## A3. Hoist `useEventStream` into `EventStreamProvider`

**Observed.** [shared/hooks/useEventStream.ts](../../frontend/src/shared/hooks/useEventStream.ts) creates an `EventSource` on every mount. AdminPage and DashboardPage both mount it; nothing prevents two simultaneous connections.

**Why it matters.** Doubles SSE load on the server when both pages are open in different tabs. Each page also keeps its own rolling 100-event buffer.

**Options.**
- **(a)** Hoist into `EventStreamProvider` (Context) wired in [src/app/providers.tsx](../../frontend/src/app/providers.tsx); consumers read via `useEventStreamCtx()`. Matches existing `WatchdogContext` / `DialogProvider` pattern.
- **(b)** Move events into a Zustand store with selectors.
- **(c)** Leave per-page.

**Trade-offs.** (a) zero new dependencies, consistent with existing patterns, Context re-renders all consumers on every event (acceptable at SSE rates). (b) selector granularity — but new dep and the consumer count doesn't justify it today. (c) doubles SSE load when ≥2 pages mount the hook.

**Recommended.** **(a).** Adopt Zustand only if profiling later shows Context re-renders hurting frame budgets.

**Effort.** S (1 day). **Risk.** low.

**Files touched.**
- New: `shared/events/EventStreamProvider.tsx`, `shared/events/useEventStreamCtx.ts`.
- Modified: `app/providers.tsx`, `features/admin/AdminPage.tsx`, `features/dashboard/DashboardPage.tsx`, `features/monitoring/MonitoringPage.tsx`.

**Depends on.** None.

---

## A4. Reusable component pass

Bundles four small wins into one PR because they touch the same files and ship the same theme ("DRY the things that obviously repeat").

### A4.1 Merge `EventCard` + `AdminEventCard`

**Observed.** [shared/events/EventCard.tsx](../../frontend/src/shared/events/EventCard.tsx) (170 LOC) and [features/admin/components/AdminEventCard.tsx](../../frontend/src/features/admin/components/AdminEventCard.tsx) (176 LOC) share `RiskBadge`/`Tag`/`normalizeThumbnail`/`humanEventType`/format helpers; differ only in enrichment row + feedback buttons (public) vs orientation/taxonomy badges (admin).

**Why it matters.** Next event-card change has to land in two files. Third variant request → third file.

**Options.** (a) `<EventCard variant="public" | "admin" | "compact">`. (b) Extract a shared `<EventCardBody>`. (c) Leave.

**Recommended.** **(a).** Document each variant's intent in the file header. Three variants is a manageable axis.

### A4.2 Extract `<EventFilterBar>` composite

**Observed.** Filter bar in [features/dashboard/DashboardPage.tsx:161–217](../../frontend/src/features/dashboard/DashboardPage.tsx) is open-coded; "show low risk" checkbox appears in `AdminPage`, `DashboardPage`, `MonitoringPage` independently.

**Recommended.** Extract `<EventFilterBar value={...} onChange={...} eventTypes={...} />` to `shared/events/`.

### A4.3 Extract `useUptime(startedAtSec)`

**Observed.** Identical 1-second `setInterval` uptime tickers at [AdminPage.tsx:86–92](../../frontend/src/features/admin/AdminPage.tsx), [DashboardPage.tsx:102–109](../../frontend/src/features/dashboard/DashboardPage.tsx), [SelectedStreamHeader.tsx:55–60](../../frontend/src/features/admin/components/SelectedStreamHeader.tsx).

**Recommended.** Extract to `shared/hooks/useUptime.ts`.

### A4.4 Wrap `TopBar` in `<PageChrome>`

**Observed.** Every page recomputes `errorCount` / `driftCount` / `connected` and passes them to `TopBar`.

**Recommended.** `<PageChrome>` reads from contexts internally; pages pass only page-specific children. (Lower priority than the other three; defer to a second PR if scope grows.)

**What this PR explicitly does NOT add.** `<Select>` / `<Toggle>` primitives. Defer until 3+ unique consumers exist outside the filter bar — avoid abstraction-for-its-own-sake.

**Effort.** M (3–4 days). **Risk.** low.

**Files touched.**
- Modified: `shared/events/EventCard.tsx` (becomes the unified card).
- Deleted: `features/admin/components/AdminEventCard.tsx` + its CSS module.
- New: `shared/events/EventFilterBar.tsx`, `shared/hooks/useUptime.ts`.
- Modified consumers: `AdminPage`, `DashboardPage`, `MonitoringPage`, `SelectedStreamHeader`, `ImpactCard`.

**Depends on.** A3 (provider order in `providers.tsx`) for `<PageChrome>` if included.

---

## A5. Pydantic models + TS codegen for the top 5 payloads

**Observed.** [frontend/src/shared/types/common.ts](../../frontend/src/shared/types/common.ts) is 340 lines hand-mirroring `backend/server.py` dict shapes (`SafetyEvent`, `LiveStatus`, `HealthData`, `LiveSourceStatus`, `DetectionSnapshot`).

**Why it matters.** Backend rename = silent FE break. The strict tsconfig can't help when the types don't reflect reality.

**Options.**
- **(a)** Pydantic models for the top 5 payloads + a generator (`fastapi-pydantic-to-typescript` or `datamodel-code-generator`) emitting `frontend/src/shared/types/generated.ts`.
- **(b)** Full OpenAPI codegen — deferred to Plan B (B3) because it requires `response_model=` on every handler.
- **(c)** Leave.

**Recommended.** **(a).** Targeted, low-risk, covers the 5 most-traversed payloads.

**Effort.** M (3–4 days, including the build-step wiring). **Risk.** medium (FE consumers must switch imports; do it in one PR per payload to keep diffs reviewable).

**Files touched.**
- New: `backend/domain/event.py`, `live_status.py`, `health.py`, `live_source.py`, `detection.py`.
- Modified: `backend/server.py` handlers for the 5 payloads use `response_model=`.
- New: `frontend/src/shared/types/generated.ts` (committed) + a `frontend/scripts/codegen.sh`.
- Modified: `frontend/src/shared/types/common.ts` re-exports the generated types where possible; legacy shapes stay until the FE migrates piecemeal.

**Depends on.** None for the generator wiring. Per-route conversion can be parallelised.

---

## A6. Extract API routers from `server.py`

**Observed.** [backend/server.py](../../backend/server.py) is 3,972 lines with 53 inline routes. Two of them have already been moved to [backend/api/settings.py](../../backend/api/settings.py) and [backend/api/feedback.py](../../backend/api/feedback.py); the remaining 51 are stranded.

**Why it matters.** Every backend change requires reading 4,000 lines of context. Test isolation is impossible.

**Options.**
- **(a)** Mechanical extraction only: one `APIRouter` per feature (`api/live.py`, `api/admin.py`, `api/road.py`, `api/agents.py`, `api/watchdog.py`, `api/retention.py`, `api/llm.py`, `api/tests.py`, `api/streams.py`); `server.py` mounts them.
- **(b)** Also move `LiveState` / `StreamSlot` / `Episode` to `backend/runtime/`.
- **(c)** Full pipeline split (Plan B B1).

**Trade-offs.** (a) mechanical, near-zero risk to the perception loop, biggest readability win per hour. (b) starts touching shared mutable state — `_on_frame` reads/writes `state.X` constantly. (c) multi-week, needs tests first.

**Recommended.** **(a)** here. (b) and (c) in Plan B.

**Effort.** L (1–2 weeks). **Risk.** low (mechanical) but scope is large — do it in 9 small PRs (one per router file) to keep blast radius bounded.

**Files touched.**
- New: 9 files under `backend/api/`.
- Modified: `backend/server.py` shrinks to lifespan + perception state + `_on_frame` + helpers + router registration.

**Depends on.** None. Recommended to land **before** A5's per-handler `response_model=` work to avoid reformatting the same routes twice.

---

## A7. Cut wasteful HTTP polling

**Observed.** Three problems compound:

- **(7.1)** [/api/live/status](../../backend/server.py) (line 2777) and [/api/admin/health](../../backend/server.py) (line 3279) overlap. FE polls both — Settings page polls *both* every 4–5 s primarily for the TopBar uptime pill.
- **(7.2)** Routes touch `state.X` without `state.lock` — works today by GIL accident; one bad day from a torn read.
- **(7.3)** `StreamImage` polls `/admin/frame/{id}` every 400 ms with no `ETag` / `If-None-Match`.

**Why it matters.** Canonical "too many API calls for UI nobody is staring at" pattern. `Settings` page open ≈ 22 status requests/min for a uptime pill.

**Options.**
- **(a)** Slow the polls for low-value UI (4 s → 10 s for `useAdminHealth`, 5 s → 15 s for `useLiveStatus` on pages where it only feeds the TopBar). One-line per hook.
- **(b)** Remove `useLiveStatus` from Settings entirely (the TopBar there can read from `useAdminHealth`).
- **(c)** Add a backend `/api/live/snapshot` superset (Plan B item B3 picks this up).
- **(d)** Add `LiveStateSnapshot()` method that takes `state.lock` once and returns a frozen dataclass — solves 7.2 and gives a single typed shape for the FE.
- **(e)** Add `ETag` on `/admin/frame/{id}`; FE sends `If-None-Match`; on 304, keep current `<img>`.

**Trade-offs.** (a) free; doesn't fix the duplication. (b) free; closes one of the two polls. (c) is bigger and belongs in Plan B. (d) addresses correctness, not bandwidth. (e) addresses just the polling fallback.

**Recommended.** **(a) + (b) + (d) + (e)** in Plan A; **(c)** in Plan B.

**Effort.** S for (a), (b), (e); M for (d). **Risk.** low.

**Files touched.**
- Frontend: `shared/hooks/useLiveStatus.ts`, `features/admin/hooks/useAdminHealth.ts`, `features/settings/SettingsPage.tsx`, `features/admin/components/StreamImage.tsx`.
- Backend: `backend/runtime/state.py` (new — for the `snapshot()` method), `backend/server.py` `live_status` + `admin_health` consume the snapshot, `admin_frame_for` returns `ETag`.

**Depends on.** A6 (router extraction) makes the backend touches cleaner but is not strictly required.

---

## A8. `useLiveSources` mutation refactor

**Observed.** [features/admin/hooks/useLiveSources.ts](../../frontend/src/features/admin/hooks/useLiveSources.ts) — every per-tile mutation calls `await refresh()`; hook also polls every 5 s. "Start all" on N sources fires N optimistic updates + N full refetches.

**Why it matters.** Bulk operations on multi-camera deployments = request storm.

**Options.**
- **(a)** Convert to `useMutation` per action; single `qc.invalidateQueries` after a bulk action settles via `Promise.allSettled`.
- **(b)** Coalesce refresh in a 250 ms debounce.
- **(c)** Leave.

**Recommended.** **(a).** Idiomatic TanStack; clean optimistic-update story.

**Effort.** S (1 day). **Risk.** low.

**Files touched.** `features/admin/hooks/useLiveSources.ts`, `features/admin/components/MultiSourceGrid.tsx` (call sites for `startAll` / `pauseAll`).

**Depends on.** None.

---

## A9. Model perf: warmup + explicit knobs

**Observed.** [core/detection.py:1140–1147](../../backend/core/detection.py) calls `model.track(frame, persist=True, tracker=TRACKER_CFG, verbose=False)` without `imgsz=`, `half=`, or `device=`. Validator (RT-DETR-L) and MiDaS depth weights load lazily on first sample.

**Why it matters.** First real frame after boot pays JIT/MPS compile cost; first validator sample after boot blocks.

**Options.**
- **(a)** Pass `imgsz=`, `half=True` (CUDA only), explicit `device=` from config; warm up the model in `lifespan` with one synthetic 640×640 zero frame.
- **(b)** Also pre-load validator + depth weights at startup.
- **(c)** Optional ONNX export (Plan B B4).

**Trade-offs.** (a) zero new dependencies, predictable first-frame latency. (b) trades startup time for steady-state — fine for a long-running edge process. (c) needs benchmarks.

**Recommended.** **(a) + (b).**

**Effort.** S (1–2 days). **Risk.** low.

**Files touched.** `backend/core/detection.py`, `backend/core/validator.py`, `backend/core/depth_neural.py`, `backend/server.py` (lifespan).

**Depends on.** None.

---

## A10. Incremental type checking (gated on approval)

**Observed.** [pyproject.toml](../../pyproject.toml) declares no type checker. `make lint` is `py_compile`.

**Why it matters.** The 22,000-line backend has no static guard rails.

**Options.**
- **(a)** `mypy --strict` allow-list: `backend/api/`, `backend/services/llm.py`, `backend/services/redact.py`. Grow over time.
- **(b)** `pyright` workspace-wide in `basic` mode.
- **(c)** Skip.

**Trade-offs.** (a) catches issues at the API boundary first; incremental adoption is manageable. (b) covers more ground but produces a noisy initial backlog. (c) lets drift bugs ship.

**Recommended.** **(a).**

**Effort.** S (config + initial fixes ≤ 1 day). **Risk.** low.

**Files touched.** `pyproject.toml` (add `[tool.mypy]`), `Makefile` (add `mypy` target).

**Depends on.** A5 (Pydantic models) lands first so the API surface is typed before mypy runs over it.

> **Per the user rule:** I will not run `mypy` or any linter without explicit approval.

---

## Suggested order of execution

If one engineer owns this, here is a sequencing that maximises safety:

1. **A2** + **A3** + **A8** (1 week). Frontend-only; low-risk; gets `usePolling` deleted, SSE consolidated, mutations idiomatic. Unblocks bandwidth findings on its own.
2. **A6** (1–2 weeks). Backend router extraction in 9 small PRs. Mechanical; near-zero risk to the perception loop.
3. **A1** + **A4** (parallel, 1 week). FE refactor + reusable-component pass. Independent of A6.
4. **A5** (3–4 days). Pydantic + codegen for top 5 payloads.
5. **A7** (3 days). Polling cuts + snapshot method.
6. **A9** (1–2 days). Model warmup + knobs.
7. **A10** (after approval). Add mypy on the new typed surface.

**Total horizon for one engineer:** ~6 weeks at a comfortable pace.

---

## Out of scope for Plan A (deliberately)

- Pipeline / `Gate` split of `_on_frame` → Plan B B1.
- `pydantic-settings` config schema → Plan B B2.
- Full OpenAPI codegen → Plan B B3.
- YOLO batching across slots / ONNX → Plan B B4.
- Cross-feature client state store → Plan B B5.
- Vitest + RTL test harness → Plan B B6.
- Repo-wide type/lint in CI → Plan B B7.
