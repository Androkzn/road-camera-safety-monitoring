# Frontend Audit - 2026-04-20

**Scope:** `frontend/src/`  
**Code size:** 10,360 LOC (TS/TSX)  
**Build check:** `npm run build` passed on April 20, 2026

## 1. Executive Summary

The frontend foundation is strong (strict TS, clear feature structure, React Query present), but the biggest risks are now maintainability and runtime efficiency in admin-heavy flows.

Top priorities:

1. Fix hook correctness/perf issues (`useDetections`, `useImpact`, `WatchdogContext`).
2. Remove redundant network churn in multi-source controls (`startAll/pauseAll` + per-mutation refresh).
3. Split oversized orchestrator files (`SettingsPage`, `MultiSourceGrid`, `EventsPanel`, `useLiveSources`).
4. Improve UI reuse primitives to cut duplication and keep view files readable.

## 2. What To Focus On First

1. **Hook correctness:** stale closures and disabled dependency checks in hot hooks.
2. **Network efficiency:** avoid N POST + N GET patterns in bulk stream actions.
3. **State re-render control:** memoize context value and normalize cross-page timer/filter logic.
4. **Modularity:** decompose page and hook files over 250-300 LOC.
5. **Reusable UI:** consolidate repeated className/error/ticker/event-card patterns.

## 3. Detailed Findings By Requested Area

### A) Type Safety

Strengths:

- Strict TS config is enabled (`strict: true`, `noUncheckedIndexedAccess: true`) in `frontend/tsconfig.app.json`.
- Very low unsafe typing usage (few casts, mostly targeted).

Gaps:

- `useDetections` uses an empty-deps callback with captured `stats.fps`, plus explicit exhaustive-deps suppression (`frontend/src/features/admin/hooks/useDetections.ts:47-52`, `:99-100`). This can freeze stale values.
- `useImpact` suppresses exhaustive-deps and runs interval on a non-memoized `refresh` (`frontend/src/features/settings/hooks/useImpact.ts:30-52`).

Recommendation:

- Treat `react-hooks/exhaustive-deps` violations as a release blocker for shared hooks.

### B) Modularity

Strengths:

- Clear `features/*` + `shared/*` separation.
- API layers exist per feature.

Gaps:

- `useLiveSources` owns list fetching, busy-state tracking, optimistic updates, lifecycle mutations, and restart token logic in one file (`250 LOC`) (`frontend/src/features/admin/hooks/useLiveSources.ts`).
- `SettingsPage` still orchestrates too many concerns (token gate, schema/effective, apply/rollback flow, impact rendering) in one component (`431 LOC`) (`frontend/src/features/settings/SettingsPage.tsx`).

Recommendation:

- Split by responsibility: data hook, mutation hook, and presentational components.

### C) Massive Files

Largest files currently:

| File | LOC | Action |
|---|---:|---|
| `frontend/src/features/settings/SettingsPage.tsx` | 431 | Split into page shell + apply workflow hook + token/empty state components |
| `frontend/src/features/admin/components/MultiSourceGrid.tsx` | 341 | Extract `StreamTile` and bulk-control toolbar |
| `frontend/src/shared/types/common.ts` | 340 | Split types by domain (`events`, `live`, `watchdog`, `settings`) |
| `frontend/src/features/settings/components/Tunable.tsx` | 323 | Keep but break sub-controls if still growing |
| `frontend/src/features/validation/components/EventsPanel.tsx` | 301 | Extract row renderer + dispute utilities |
| `frontend/src/features/watchdog/components/WatchdogDrawer.tsx` | 294 | Optional split into sections |

### D) Network Performance (redundant/unnecessary calls)

Findings:

- Every source mutation triggers `refresh()` in `finally`, causing extra GETs (`frontend/src/features/admin/hooks/useLiveSources.ts:101-117`, `122-138`, `143-161`, `166-175`, `180-195`, `203-231`).
- Bulk start/pause loops call per-source mutation, which compounds request count (`frontend/src/features/admin/components/MultiSourceGrid.tsx:242-250`).
- Polling image mode creates one 400ms interval per tile (`frontend/src/features/admin/components/StreamImage.tsx:133-136`) and forces fresh frame requests (`:150`).
- `useSettings` and `useImpact` still do manual interval polling rather than single Query-driven strategy (`frontend/src/features/settings/hooks/useSettings.ts:99-104`, `frontend/src/features/settings/hooks/useImpact.ts:46-52`).
- Fetch wrappers do not expose/forward `AbortSignal`; stale requests cannot be canceled cleanly (`frontend/src/shared/lib/fetchClient.ts:11-14`, `frontend/src/shared/lib/adminApi.ts:94-115`).
- `HistoryPanel` triggers mount refresh through empty-deps effect instead of delegating fully to query lifecycle (`frontend/src/features/admin/components/HistoryPanel.tsx:72-74`).

Recommendations:

- Add batched backend endpoints for bulk start/pause and single post-action invalidation.
- Standardize on React Query `refetchInterval` + cancellation.
- Introduce a shared polling coordinator for tile thumbnails when MJPEG is not used.

### E) UI Reuse and Main View Readability

Findings:

- Repeated className composition logic (no shared `cx` helper).
- Repeated error-list rendering and repeated page uptime ticker logic.
- Large view files carry both orchestration and UI rendering, reducing readability.

Recommendations:

- Add `shared/lib/cx.ts`, `shared/ui/ErrorList.tsx`, `shared/hooks/useUptimeTicker.ts`.
- Move filtering/sorting/dispute mapping into feature-level utilities.
- Keep page components as composition shells (target: <= 220 LOC).

### F) Hooks

High-value issues:

- `useLiveSources` is over-scoped and should be split.
- `useDetections` stale closure risk around FPS.
- `useImpact` dependency suppression.

Recommended split:

- `useLiveSourcesList()`
- `useSourceLifecycleMutations()`
- `useRestartAll()`

### G) State Management Improvements

Strengths:

- Most server state already lives in React Query, which is correct.

Issues:

- `WatchdogContext` provider value is recreated each render (`frontend/src/features/watchdog/WatchdogContext.tsx:120-129`), causing avoidable downstream re-renders.

Recommendations:

- Memoize provider `value` with `useMemo`.
- Keep app-level context small; push more server state reads to query hooks directly.

## 4. Prioritized Issue List

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| FE-1 | High | Hook stale closure / dependency suppression in detection-impact paths | `useDetections.ts:47-52,99-100`; `useImpact.ts:46-52` |
| FE-2 | High | Watchdog context value not memoized -> extra renders | `WatchdogContext.tsx:120-129` |
| FE-3 | Medium | Multi-source bulk actions create redundant network cycles | `useLiveSources.ts:101-231`; `MultiSourceGrid.tsx:242-250` |
| FE-4 | Medium | No request cancellation support in fetch layer | `fetchClient.ts:11-14`; `adminApi.ts:94-115` |
| FE-5 | Medium | Main page/hook files too large for easy maintenance | `SettingsPage.tsx`, `MultiSourceGrid.tsx`, `EventsPanel.tsx`, `useLiveSources.ts` |
| FE-6 | Low | Reusable UI primitives missing for repeated patterns | multiple view files |
| FE-7 | High | SSE connection is per-page, not per-app — two pages = two EventSources | `shared/hooks/useEventStream.ts`; see §D6 |
| FE-8 | High | `useEventStream` returns a `ref.current` as state (silent stale-count bug) | `shared/hooks/useEventStream.ts:17,49`; see §D8 |
| FE-9 | Medium | Admin-token "cross-tab sync" is broken — `window.dispatchEvent` + `sessionStorage` is same-tab only | `useAdminToken.ts:4-6`; `adminApi.ts:35,44` — see §D10 |
| FE-10 | Low | Dead `admin-focused-id-changed` CustomEvent, exhaustive-deps audit drive-by | `AdminPage.tsx:60`; see §D9 |
| FE-11 | Blocker | Admin-tier endpoints used by FE assume BE-side auth — today most BE mutations are `AUTH: public`. **Cross-doc issue.** | See [backend audit BE-D12](backend-audit-2026-04-20.md#be-d12---control-endpoints-unauthenticated-be-12-critical) |

## 5. Showcase Framing (What This Demonstrates)

This plan is designed to showcase two capabilities:

1. **Code reading depth:** findings are tied to concrete files/lines and behavior, not generic advice.
2. **Engineering judgment:** improvements are prioritized by impact/risk, with explicit trade-offs.

Strong expertise signals to highlight:

1. Type-safety judgment in hooks and API boundaries.
2. Structural judgment on god files vs feature-local decomposition.
3. Performance judgment on unnecessary API calls for non-critical UI.
4. Product judgment on where reusable components actually reduce maintenance cost.

## 6. Decisions And Trade-Offs

Each decision below follows the same shape: **Observation** (what the code shows), **Why it matters**, **Options** with trade-offs, **Recommendation**. The intent is to separate evidence from opinion and expose judgment, not hand out a checklist.

---

### D1 - Shrink `SettingsPage.tsx` (god file, 431 LOC)

**Observation.** [SettingsPage.tsx](frontend/src/features/settings/SettingsPage.tsx) mounts `TokenPrompt`, `SettingsHeader`, `Tunables`, `Templates`, `Baseline`, `Impact`, and `LivePreview`, and owns draft state + validate/apply/rollback + token-prompt flow in one file. The apply/rollback lifecycle spans L112-255; the token empty-state is L305-316. Layout is small; **orchestration is what's large.**

**Why it matters.** Every new settings feature lands here. Review load scales with file size, not diff size. Testing the apply lifecycle currently requires mounting the full page.

**Options**

| Option | Trade-offs |
|---|---|
| A - Extract `useSettingsApply()` hook + `TokenEmptyState.tsx` component | 1 day. Pure refactor; JSX unchanged. Page drops ~200 LOC. Apply lifecycle becomes unit-testable without React. |
| B - Decompose into `<SettingsShell>` + `<SettingsForm>` + `<SettingsActions>` with a local settings context | 2-3 days. More testable units. Introduces a settings-local context; risk of over-sharing state. Only worth it if settings gains more features. |
| C - Leave as-is; add an ESLint `max-lines` rule | 0 effort. Documents the debt without repaying it. |

**Recommended: A now, B only if settings grows.** A closes ~80% of the maintainability gap with a pure-refactor PR. B is the right move *later*, when the page has outgrown hooks-plus-components.

**Acceptance criteria.**
- `SettingsPage.tsx` ≤ 280 LOC.
- `useSettingsApply` has ≥1 test per flow branch: happy path, privacy-confirm required, admin-auth failure, 409 conflict, 429 rate limit.
- `TokenEmptyState.tsx` exists as a standalone component; no token-prompt JSX remains inline in `SettingsPage.tsx`.

**Rollout / rollback.** Pure-refactor PR - same JSX, same side effects. Revert is a single git revert. No flag needed.

---

### D2 - UI that calls the API for non-critical data

**Observation.** The canonical "too many API calls for not important UI" case is on the Settings page:

- [useLiveStatus:16](frontend/src/shared/hooks/useLiveStatus.ts#L16) polls `/api/live/status` every 5s.
- [useAdminHealth:8](frontend/src/features/admin/hooks/useAdminHealth.ts#L8) polls `/api/admin/health` every 4s.
- [SettingsPage.tsx:63-64](frontend/src/features/settings/SettingsPage.tsx#L63) mounts **both** - primarily to feed the TopBar uptime pill. That's ~22 requests/minute for a cosmetic indicator nobody is watching second-by-second. The two endpoints also overlap substantially in returned fields (see [backend audit BE-D11](backend-audit-2026-04-20.md#be-d11---apilivestatus-and-apiadminhealth-overlap)).

Additional patterns:

- 1-second uptime tickers duplicated in [AdminPage:86-92](frontend/src/features/admin/AdminPage.tsx#L86), [DashboardPage:102-109](frontend/src/features/dashboard/DashboardPage.tsx#L102), [SelectedStreamHeader:55-60](frontend/src/features/admin/components/SelectedStreamHeader.tsx#L55), plus [ImpactCard:36](frontend/src/features/settings/components/ImpactCard.tsx#L36) - cosmetic, zero network but three timers running when two pages are split-screen.
- [useSettings:99-104](frontend/src/features/settings/hooks/useSettings.ts#L99) - hand-rolled `setInterval(refresh, 15_000)`. Fires even in background tabs.
- [useImpact:46-52](frontend/src/features/settings/hooks/useImpact.ts#L46) - same pattern at 5s, plus exhaustive-deps suppression.
- [useLiveSources:101-231](frontend/src/features/admin/hooks/useLiveSources.ts#L101) - every per-source mutation fires `refresh()` in its `finally`; bulk actions in [MultiSourceGrid:242-250](frontend/src/features/admin/components/MultiSourceGrid.tsx#L242) call those mutations in a loop, so "Pause all" on 6 sources = 6 POSTs + 6 GETs + a 5s polling refresh landing on top.
- [usePolling.ts](frontend/src/shared/hooks/usePolling.ts) is **dead code** - no consumer imports it; delete rather than migrate.

**Why it matters.** The settings hooks bypass TanStack Query's `refetchIntervalInBackground` and `refetchOnWindowFocus`, so a backgrounded admin tab keeps hitting `/api/settings/*` every 15s for UI nobody is watching. Bulk actions amplify chattiness exactly when the server is handling an incident.

**Options**

| Option | Trade-offs |
|---|---|
| A - Slow the low-value polls: `useLiveStatus` 5s -> 15s, `useAdminHealth` 4s -> 10s on pages that only render the TopBar pill | 1 line per hook. Instant ~3x traffic cut. Doesn't consolidate endpoints. |
| B - Migrate `useSettings`/`useImpact` to React Query with `refetchInterval` + `refetchIntervalInBackground: false` + `refetchOnWindowFocus: true`. Delete `usePolling.ts`. | 2h. Reuses existing infra. Stops background-tab traffic. |
| C - Add shared `useUptimeTicker()` + do B | +1h. One implementation of the ticker. Deletes four duplicated `setInterval`s. |
| D - Refactor `useLiveSources` to `useMutation` + a single `qc.invalidateQueries` after the bulk action settles. FE-only. | 0.5 day. Reduces N refresh GETs to 1 invalidation, but per-source POSTs still happen (N→N+1 total, not N→2). |
| D+ - Pair D with a new BE bulk endpoint `POST /api/live/sources/bulk` accepting `{ids: string[], action: "start"\|"pause"}` | +1 day BE (see BE-D16 in the backend audit). Reduces N+N → 2. **Must be paired with auth (BE-D12).** |
| E - Add `/api/live/snapshot` superset endpoint on BE so the two polls collapse to one | Requires BE work; see [BE-D11](backend-audit-2026-04-20.md#be-d11---apilivestatus-and-apiadminhealth-overlap). Plan B territory. |

**Recommended: A + B + C + D in Plan A; E in Plan B.** Low-importance UI should not pay server-side cost, and the ticker duplication is the clearest shared-hook case in the codebase. The Settings-mounts-both-polls finding is the single biggest "wasteful traffic" lever.

> Note: TanStack Query is for request/cache state. SSE (`useSSE`, `useEventStream`) stays for push-driven data - they solve different problems.

**Acceptance criteria.**
- Background Settings tab issues **zero** `/api/settings/*` requests and **zero** `/api/admin/health` requests during a 60s idle observation (verify via devtools Network tab with tab backgrounded).
- **FE-only (D2.D):** "Pause all" on 6 sources fires ≤7 network requests (6 per-source POSTs + 1 cache invalidation) vs. today's 12. This is the ceiling for FE-only work — per-source POSTs are structural.
- **FE + BE bulk endpoint (D2.D+, depends on [BE-D16](backend-audit-2026-04-20.md#be-d16---bulk-source-control-endpoint)):** "Pause all" on 6 sources fires ≤2 network requests (1 bulk POST + 1 invalidation). Schedule this as a follow-on once BE-D16 ships.
- `grep -rE 'setInterval' frontend/src/` returns only: `StreamImage` 400ms poll (intentional), `useUptimeTicker` internal (single source), and nothing under `features/settings/`.
- `shared/hooks/usePolling.ts` deleted.

**Rollout / rollback.**
- All changes are FE-only and independently revertible per PR. No coordination with BE required for A-D. Option E follows [BE-D11](backend-audit-2026-04-20.md#be-d11---apilivestatus-and-apiadminhealth-overlap) rollout.
- Observability: FE can log `query_key` + `interval_ms` on mount to confirm hooks converged to the new cadence.

---

### D3 - `WatchdogContext` cascading re-renders

**Observation.** [WatchdogContext.tsx:120-129](frontend/src/features/watchdog/WatchdogContext.tsx#L120) builds `value` inline in render. Every consumer - MonitoringPage, SettingsPage, DashboardPage, WatchdogDrawer - re-renders on *any* parent re-render, even when `data` is unchanged.

**Why it matters.** Correctness/perf bug, not style. Also a one-line fix, which makes not fixing it hard to justify.

**Options**

| Option | Trade-offs |
|---|---|
| A - Wrap `value` in `useMemo` | 15 min. Zero design change. Fixes the issue. |
| B - Replace context with Zustand | Overkill for one context. Adds a dependency for no other use case. |
| C - Split into data-only context + callbacks-only context so consumers subscribe narrowly | Cleaner if watchdog grows more consumers; premature today. |

**Recommended: A.** Revisit C only if more pages subscribe to it.

**Acceptance criteria.** With MonitoringPage + SettingsPage both mounted, React DevTools Profiler records **zero** re-renders of watchdog consumers across 10 unrelated parent re-renders.

**Rollout / rollback.** 1-line change; single PR; trivial revert.

---

### D4 - Reusable-component gaps

**Observation.** Several concrete duplications across layers:

- **41 hand-composed className sites** using `.filter(Boolean).join(" ")` - MultiSourceGrid:57-64, EventCard:60, EventsPanel:248-275, AdminEventCard, etc. No `cx()` utility.
- **`RiskBadge` underused** - 5+ components rebuild the risk->color mapping inline despite `RiskBadge` existing in `shared/ui/`.
- **`EventCard` (170 LOC) + `AdminEventCard` (176 LOC)** share ~80% structure (thumbnail + RiskBadge + event-type + time + kinematic tags + narration). They diverge on enrichment row + `FeedbackButtons` (public) vs. orientation + taxonomy badges (admin).
- **Error-list rendering** repeated in [SettingsPage.tsx](frontend/src/features/settings/SettingsPage.tsx), `TokenPrompt`, validation dialogs.
- **Open-coded form controls**: filter bar in [DashboardPage:161-217](frontend/src/features/dashboard/DashboardPage.tsx#L161) uses raw `<select>` + checkbox + clear button; detection toggle in [MultiSourceGrid:158-168](frontend/src/features/admin/components/MultiSourceGrid.tsx#L158) is a raw `<input type="checkbox">`. The same "show low risk" checkbox appears in AdminPage/DashboardPage/MonitoringPage independently. No `<Select>`, `<Toggle>`, or `<EventFilterBar>` composite.
- **`TopBar` props recomputed per page**: every page does `const { status: wdStatus } = useWatchdogCtx(); const driftCount = useDriftCount();` and passes `errorCount={wdStatus?.by_severity?.error ?? 0}` - adding a new TopBar metric means editing all four pages.

**Why it matters.** `shared/ui/` is solid for primitives (Button, Dialog, Card...) but missing the layer above - **composites**. The gap is not in primitives; it's in the layer on top. The stronger argument for extracting inline components is **testability, reviewability, and shared ownership** - not render cost.

**Options**

| Option | Trade-offs |
|---|---|
| A - `shared/lib/cx.ts` + `shared/ui/ErrorList` + adopt `RiskBadge` at inline sites | 0.5 day. Pure refactors. |
| B - `<EventFilterBar>` composite (3 clear call sites) + `<PageChrome>` wrapping `TopBar` so it reads contexts internally | 0.5 day. Removes four copies of TopBar prop plumbing; one filter bar instead of three variants. |
| C - Do A + B + `<EventCard variant="public" \| "admin" \| "compact">` with slot-style props (`actions`, `header`, `footer`); refactor both existing cards on top | 1-2 days. Removes ~100 LOC of duplication. Variant API may grow wide; document intent in the file header. |
| D - Add low-level `<Select>` + `<Toggle>` to `shared/ui/` | Only once 3+ unique consumers exist outside the filter bar. Avoid abstraction-for-its-own-sake. |
| E - Storybook for `shared/ui/*` with visual snapshots | +1 day. Pays off as primitives multiply; premature today. |

**Recommended: A + B in Plan A; C when the filter bar is already a composite (so `EventCard` variants can reuse its primitives). Hold D until three unique consumers exist; hold E until `shared/ui/` hits ~25 components.**

---

### D5 - `useLiveSources` at 250 LOC

**Observation.** [useLiveSources.ts](frontend/src/features/admin/hooks/useLiveSources.ts) exposes `start`, `pause`, `setDetection`, `add`, `remove`, `restartAll` + busy tracking + optimistic updates in one hook. Any component using even one mutator pulls the whole surface. [MultiSourceGrid](frontend/src/features/admin/components/MultiSourceGrid.tsx) prop-drills mutator callbacks into each tile instead of letting tiles own their own controls.

**Options**

| Option | Trade-offs |
|---|---|
| A - Split into `useLiveSourcesList` (polling), `useStreamControl(id)` (per-tile: start/pause/setDetection + busy), `useStreamRegistry` (add/remove/restartAll) | 1 day. SRP wins. `StreamTile` calls `useStreamControl(id)` directly; MultiSourceGrid stops prop-drilling. Cleanest path. |
| B - Keep as one hook, move busy state into a separate `useSourceBusy` | 0.5 day. Smaller win; leaves the 7-mutator sprawl. |
| C - Do nothing | 0 effort. Hook keeps accreting. |

**Recommended: A**, paired with the `StreamTile` extraction from MultiSourceGrid - they're the same decomposition viewed from two sides. Once the tile owns its own controls hook, the grid shrinks to layout + focus/minimize state.

---

### D6 - SSE connection is per-page, not per-app

**Observation.** [shared/hooks/useEventStream.ts](frontend/src/shared/hooks/useEventStream.ts) creates a new `EventSource` every time a component mounts the hook. Both `AdminPage` and `DashboardPage` mount it. Nothing prevents two simultaneous connections when a user opens both pages in split-screen, in two tabs, or if an embedded panel also mounts the hook. Each page also keeps its own rolling 100-event buffer.

(Correction to an earlier version of this audit: routes are already `React.lazy`-loaded with `<ErrorBoundary>` + `<Suspense>` around each at [frontend/src/app/router.tsx](frontend/src/app/router.tsx). That finding was wrong and is removed.)

**Why it matters.** Two mounted consumers = two open `EventSource` connections, which means the server fans out every safety event twice, and the FE maintains two parallel event buffers that can drift. This is the textbook case for hoisting into app-level state.

**Options**

| Option | Trade-offs |
|---|---|
| A - Hoist into `<EventStreamProvider>` in [src/app/providers.tsx](frontend/src/app/providers.tsx); consumers read via `useEventStreamCtx()`. Matches the existing `WatchdogContext` / `DialogProvider` pattern. | 2-3h. Zero new dependencies. Consistent with the rest of the FE. One `EventSource` for the whole app. |
| B - Move event stream into a Zustand store; consumers read with selectors | Finer-grained re-renders if selector pressure ever matters. Adds a new dependency for a single use case - not justified by today's consumer count. |
| C - Leave | Doubles SSE load when ≥2 pages mount the hook. Event buffers diverge silently. |

**Recommended: A.** Reach for Zustand (B) only when a profiled selector hotspot appears; nothing in the current consumer set justifies it.

**Acceptance criteria.**
- With AdminPage + DashboardPage both mounted, browser devtools Network tab shows exactly **one** open `EventSource` connection to `/stream/events`.
- Disconnecting/reconnecting the connection surfaces the same event buffer to every consumer (verified by mounting a test component that reads `useEventStreamCtx()` and showing the same `events.length` as the other pages).
- `countsRef.current` in [useEventStream.ts](frontend/src/shared/hooks/useEventStream.ts) is removed (D8 folds in here).

**Rollout / rollback.**
- Ship `<EventStreamProvider>` alongside the existing hook for **one release**; add a console warning if the raw hook is mounted directly. Next release removes the raw path.
- Observability: FE metric `event_source_mount_count` logged to telemetry; target 1 per tab.
- Rollback: revert the provider PR; raw-hook path continues working (no breaking API during the coexistence window).

---

### D7 - Type-safety posture

**Observation.** Strict TS is on, `any` count is 0, `@ts-ignore` count is 0 - the foundation is solid. The one real gap is runtime contract: the BE returns raw dicts (`response_model=` is absent on all routes) so the FE re-types everything by hand in `shared/types/common.ts` (340 LOC). Any field rename on BE ships silently to production.

**Options**

| Option | Trade-offs |
|---|---|
| A - Keep compile-time TS types only | Misses runtime drift between FE/BE. |
| B - Add `zod` schemas at the fetch layer for the 6 highest-traffic endpoints; infer TS types from schemas | 1 day. Catches drift at the boundary. Doesn't require BE changes. |
| C - Wait for BE to generate OpenAPI types (Pydantic `response_model` rollout) and consume those | 0 FE effort. Blocked on BE. Single source of truth once delivered. |

**Recommended: C if BE is willing** (it's the right long-term answer and shows up in the BE audit as BE-D6). Fall back to B if BE rollout is >1 quarter away. Either beats A.

**See [backend audit §9 — Contract Migration Plan](backend-audit-2026-04-20.md#9-contract-migration-plan-shared-with-fe-d7)** for the shared phased rollout. FE owns Phases 2 and 3; BE owns Phases 1 and 4. Each phase waits one full release before the next - **no lockstep deploys required.**

**Acceptance criteria (FE side).**
- `frontend/src/shared/types/generated.ts` builds from `/openapi.json` via a Vite plugin or `npm run build:types` script.
- Settings migrates first (smallest blast radius, and it's the feature already front-and-center in §7.1). Post-migration: no hand-mirrored types for settings endpoints remain in [common.ts](frontend/src/shared/types/common.ts).
- Validation, Admin, Dashboard follow in order; each shipped as its own PR.

**Rollout / rollback.**
- If BE Phase 1 is delayed beyond a quarter, activate D7.B: add `zod` schemas at the fetch layer for the 6 endpoints. Scope strictly to those 6 - no broader zod adoption.
- Rollback at any phase: revert the per-feature type-import PR; legacy `common.ts` types continue working.

---

### D8 - `useEventStream` returns a ref as state

**Observation.** [shared/hooks/useEventStream.ts:17,49](frontend/src/shared/hooks/useEventStream.ts#L17):

```ts
const countsRef = useRef({ total: 0, high: 0, medium: 0 });
// ...
return { events, perception, connected, counts: countsRef.current, clearEvents };
```

Consumers don't re-render when `counts` changes - only when `events` changes. The bug is hidden today because every `counts` mutation happens in the same callback that also pushes to `events`, so React re-renders anyway. If anyone ever updates counts without also pushing an event, consumers will silently display stale counts.

**Why it matters.** Small trap, real silent-bug potential. It would be caught by any test that asserts a count independently of the latest event.

**Options**

| Option | Trade-offs |
|---|---|
| A - Derive counts from `events` in a `useMemo` in consumers (drop the ref entirely) | Small. `O(events.length)` ≤ 100 is negligible. Removes the trap and reduces the hook's return surface. |
| B - Move counts to `useState` | Correct, but introduces an extra setter call per event. |
| C - Document the coupling and leave | Zero effort; leaves the trap primed. |

**Recommended: A.** If D6 (hoist SSE into a provider) lands, counts become a trivial derivation in the provider - fold D8 into that PR.

---

### D9 - Small cleanups surfaced during review

**Observation.**
- [AdminPage.tsx:60](frontend/src/features/admin/AdminPage.tsx#L60) dispatches `admin-focused-id-changed` via `CustomEvent`; no consumer subscribes. Likely vestigial.
- A handful of `eslint-disable react-hooks/exhaustive-deps` sites - [useDetections.ts:99](frontend/src/features/admin/hooks/useDetections.ts#L99) (intentional, FPS ref), [DashboardPage.tsx:96-97](frontend/src/features/dashboard/DashboardPage.tsx#L96) (test auto-open). Each is a small bet; enough of them dilute the lint rule.

**Recommendation.** Delete the `admin-focused-id-changed` dispatch once confirmed unused. Audit each exhaustive-deps disable as you touch the surrounding hook; replace with `useRef` or `useEffectEvent` when it stabilizes. No standalone PR - drive-bys.

---

### D10 - Admin-token "cross-tab sync" is broken

**Observation.** [useAdminToken.ts:4-6](frontend/src/shared/hooks/useAdminToken.ts#L4) advertises: *"Listens for the `admin-token-changed` custom event so two SettingsPage instances open in different tabs (or any other consumer) stay in sync."* The implementation [adminApi.ts:35,44](frontend/src/shared/lib/adminApi.ts#L35) does `window.dispatchEvent(new CustomEvent("admin-token-changed"))`.

**Two independent problems.**
1. `window.dispatchEvent` fires **only in the current window**. Cross-tab synchronization requires either the `storage` event (which only fires for `localStorage`, not `sessionStorage`) or a `BroadcastChannel`.
2. `sessionStorage` is **per-tab** - setting a token in tab A does not put the value in tab B's `sessionStorage` at all. The comment is wrong on two counts.

**Why it matters.** Operators opening two tabs (one Settings, one Admin) must paste the token twice. Worse, the docstring *claims* it works, so contributors building on top of the hook assume a guarantee the runtime does not provide.

**Options**

| Option | Trade-offs |
|---|---|
| A - Fix the docstring. Accept per-tab token entry as the current behaviour. | 5 min. Honest. Operator still pastes twice. |
| B - Use `localStorage` + listen to the `storage` event for real cross-tab sync | 30 min. Token persists across tabs *and* across browser restarts (security trade-off: longer exposure window for a compromised token). Consider pairing with an explicit expiry. |
| C - Use `sessionStorage` + `BroadcastChannel("admin-token")` for cross-tab sync within a single browser session | 30 min. Preserves the session-scoped lifetime; fixes the sync bug. |
| D - Leave the buggy comment and code | Invites surprise. |

**Recommended: C.** Preserves the "session-scoped token" property (which is a real security property - a closed tab doesn't leak credentials) and delivers the cross-tab sync the comment promises. B is acceptable if the ops team prefers persistence and has a separate rotation story.

**Acceptance criteria.**
- Setting the token in tab A causes tab B's `useAdminToken()` to update within 100ms.
- Clearing in either tab clears the other.
- Closing all tabs and reopening starts with no token (preserves session scope if C is chosen).
- Docstring matches behaviour.

**Rollout / rollback.** Pure FE change; single PR; trivial revert.

---

### DSec - Cross-doc dependency on BE auth boundary

**Observation.** The FE already sends `Authorization: Bearer` for endpoints wrapped by [adminApi.ts](frontend/src/shared/lib/adminApi.ts). However, many of the endpoints the FE mutates (`POST /api/live/sources`, `POST /api/live/sources/{id}/start`, `POST /api/validator/toggle`, `POST /api/tests/run`, MJPEG feeds) are currently `AUTH: public` on the BE side - see [backend audit BE-D12, BE-D13](backend-audit-2026-04-20.md#be-d12---control-endpoints-unauthenticated-be-12-critical).

**FE-side implications once BE-D12/D13 land.**
- `<img src="/admin/video_feed/...">` and `<EventSource("/admin/detections")>` cannot send an `Authorization` header. FE must migrate to the signed-URL flow (BE-D13.B): fetch a short-lived URL via an authenticated JSON call, then use it in `<img>` / `EventSource`.
- [StreamImage.tsx](frontend/src/features/admin/components/StreamImage.tsx) needs a refresh loop that re-mints URLs before expiry.
- `useEventStream` (after D6 hoist) needs the same mint-before-reconnect behaviour.

**Recommendation.** Plan FE work as a **follow-on to BE-D13**, not in parallel. Track as a dependent item. FE changes are ~1 day once the BE-side signed-URL endpoint exists.

---

## 7. Sequencing

Ordered by **correctness -> cleanup -> structure**, not by file.

**~1 week of FE capacity:**
D3 (15 min, correctness bug) -> D6.A (hoist SSE provider, 2-3h) + D8.A folded in -> D2.A+B+C (slow polls + ticker + migrate manual-polling hooks, half day) -> D4.A+B (cx, ErrorList, RiskBadge adoption, EventFilterBar, PageChrome, ~1 day) -> D1.A (SettingsPage hook extraction, 1 day) -> D2.D (bulk-action invalidation, 4h) -> D9 drive-bys.

**~3 weeks of FE capacity:**
The above, then D5.A + `StreamTile` extraction (1 day) -> D7.B or C depending on BE timeline (types from OpenAPI or zod at the boundary) -> D1.B only if settings keeps growing -> D4.C only if a third event-card variant appears.

**What to resist:**
- Introducing Zustand for a single context or for the event stream.
- Designing a `BaseEventCard` off only two samples.
- Calling a `usePolling` -> TanStack Query migration "eliminates ~200 lines of boilerplate" - the real win is one abstraction in place of two, not a specific LOC count.
- Treating SSE as something TanStack Query can replace. It can't; they solve different problems. Hoist SSE to its own provider instead (D6).
- Claiming code-splitting gains without measuring - routes are already lazy-loaded.

**What this sequencing demonstrates:**
1. Correctness bugs first (D3 context memo, D6 double-SSE, D8 stale counts).
2. Network hygiene before refactors (D2 before D1, D5).
3. Composites before primitives (D4.B before D4.D) - let real duplication drive the shared surface.
4. Incremental wins that each ship independently - no PR requires another to land first.

---

## 7.1 Feature rollups — Settings and Validation

The decisions above are cross-cutting. For clarity, here's how they group per feature when it's time to assign ownership.

### Settings (`features/settings/`)

**Relevant decisions:** D1, D2, D4 (ErrorList), D7 (types).
**In scope:**
- **D1.A — Extract `useSettingsApply` + `TokenEmptyState`.** [SettingsPage.tsx](frontend/src/features/settings/SettingsPage.tsx) drops from 431 → ~280 LOC. Apply/rollback/template-apply lifecycle becomes unit-testable without the page. 1 day.
- **D2.A — Slow `useLiveStatus`/`useAdminHealth` polls on Settings.** Settings mounts both just to feed the TopBar uptime pill - slow them to 15s/10s on this page. 1 line change per hook. This is the single biggest "too many API calls for not important UI" fix.
- **D2.B — Migrate [useSettings:99-104](frontend/src/features/settings/hooks/useSettings.ts#L99) and [useImpact:46-52](frontend/src/features/settings/hooks/useImpact.ts#L46) from hand-rolled `setInterval` to React Query** with `refetchIntervalInBackground: false`. Stops background-tab traffic. 2h.
- **D4.A — Adopt `<ErrorList>`** for the repeated error-array rendering in SettingsPage / TokenPrompt.
- **D7.C — Consume generated types from BE once BE-D6 lands;** drop the hand-mirrored slice of [shared/types/common.ts](frontend/src/shared/types/common.ts).

**Definition of done:**
- SettingsPage ≤ 280 LOC.
- Apply/rollback flows covered by hook-level tests.
- Background Settings tab issues zero `/api/settings/*` or `/api/admin/health` requests.
- Error rendering goes through `<ErrorList>`.

### Validation (`features/validation/`)

**Relevant decisions:** new DV1 below, D4 (composites), D6 (shared SSE), D8 (counts).
**In scope:**
- **DV1 — Split [EventsPanel.tsx](frontend/src/features/validation/components/EventsPanel.tsx) (301 LOC).** Extract `<EventRow>` (L241-300, ~60 LOC) into its own file; move verdict-mapping + dispute-parsing pure functions to `features/validation/utils/verdict.ts`. Panel shrinks to ~180 LOC of composition. 2-3h.
- **D4.B — Adopt `<EventFilterBar>`** once it lands; validation currently hand-rolls its own filter controls.
- **D4.C — Refactor onto `<EventCard>` variants** if C goes ahead; validation's event row can become `<EventCard variant="compact">`.
- **D6 — Consume events from the hoisted `EventStreamProvider`** instead of opening its own SSE connection when Validation is open alongside Admin/Dashboard.
- **D8 — Derive counts from `events`** if validation ever renders a count; avoids the `countsRef.current` trap.

**Definition of done:**
- `EventsPanel.tsx` ≤ 200 LOC.
- `verdict.ts` / `dispute.ts` utilities have unit tests.
- Validation does not open a second `EventSource` when mounted alongside another SSE consumer.

### Why call these two out

Both features are where the **reviewer signal is loudest**: Settings is the clearest god-page, and Validation is the clearest case where a feature can visibly consume the shared surfaces (composites, SSE provider, typed contracts) the rest of the work creates. Shipping both as named deliverables lets each improvement land with a demo rather than a diff.

---

## 8. Execution Matrix

One row per actionable FE decision. **Depends-on** cites backend IDs where cross-doc. **Accept** points to the decision's acceptance criteria. Sprint numbers align with [backend audit §10](backend-audit-2026-04-20.md#10-execution-matrix).

| ID | Decision | Effort | Depends-on | Accept | Sprint |
|---|---|---|---|---|---|
| D3 | `WatchdogContext` memoize | 15 min | - | §D3 | 1 |
| D6 | Hoist SSE into `EventStreamProvider` | 2-3 h | - | §D6 | 1 |
| D8 | Fold `countsRef` → derived; drop from return | 30 min | D6 | §D8 | 1 |
| D2.A | Slow overlapping polls on Settings | 1 h | - | §D2 | 1 |
| D2.B | `useSettings` / `useImpact` → React Query; delete `usePolling.ts` | 2 h | - | §D2 | 1 |
| D2.C | `useUptimeTicker` shared hook | 1 h | - | §D2 | 1 |
| D4.A | `cx` util + `<ErrorList>` + adopt `RiskBadge` at inline sites | 0.5 day | - | §D4 | 1 |
| D4.B | `<EventFilterBar>` composite + `<PageChrome>` wrapper | 0.5 day | - | §D4 | 1 |
| D1.A | `useSettingsApply` + `TokenEmptyState` | 1 day | - | §D1 | 1 |
| D2.D | `useLiveSources` → `useMutation` + single invalidation | 0.5 day | - | §D2 | 1 |
| D9 | Drive-by cleanups (dead CustomEvent, exhaustive-deps audit) | drive-by | - | §D9 | 1 |
| D10 | Fix admin-token cross-tab sync (`BroadcastChannel`) + doc | 30 min | - | §D10 | 1 |
| DSec | Migrate `<img>`/`EventSource` consumers to signed-URL flow | 1 day | [BE-D13](backend-audit-2026-04-20.md#be-d13---live-mediadetection-streams-unauthenticated-be-13-critical) | §DSec | 0/1 (follows BE-D13) |
| D5.A | Split `useLiveSources` + extract `StreamTile` | 1 day | - | §D5 | 2 |
| DV1 | Split `EventsPanel` | 2-3 h | D4.B preferred | §7.1 Validation | 2 |
| D7 Ph2 | Emit `generated.ts` from `/openapi.json` | 2 days | BE-D6.A Ph1 | §D7, [BE §9](backend-audit-2026-04-20.md#9-contract-migration-plan-shared-with-fe-d7) | 2 |
| D7 Ph3.Settings | Migrate Settings feature to generated types | 2-3 days | D7 Ph2 | §7.1 Settings | 2 |
| D7 Ph3.Validation | Migrate Validation feature | 2-3 days | D7 Ph3.Settings | §7.1 Validation | 3+ |
| D7 Ph3.Admin+Dashboard | Migrate remaining features | 3-5 days | Validation done | §D7 | 3+ |
| D4.C | `<EventCard variant>` refactor | 1-2 days | 3rd variant appears | §D4 | 3+ |
| D1.B | SettingsPage full decomposition | 2-3 days | Settings keeps growing | §D1 | 3+ |
| D7.B (fallback) | `zod` bridge for 6 endpoints | 1 day | BE Ph1 slips >1 quarter | §D7 | fallback |

**Reading the matrix.**
- Sprint 1 is FE-only, zero BE dependency. All items are ≤1 day and independently revertible.
- Sprint 2 begins once BE Phase 1 ([backend §9](backend-audit-2026-04-20.md#9-contract-migration-plan-shared-with-fe-d7)) ships. FE generates types alongside `common.ts` and migrates Settings first.
- Sprint 3+ items are evidence-gated or depend on other features finishing.

## 9. Notes

1. This audit is static/runtime-logic focused from source inspection plus local frontend build verification.
2. Backend tests could not be run in this workspace because Python test tooling is not currently runnable here (broken `.venv` interpreter path and no system `pytest`). **This is itself the primary argument for [Sprint 0](backend-audit-2026-04-20.md#8-sprint-0--verification-prerequisites) - FE Sprint 1 can proceed independently, but any BE-dependent FE work waits until BE tooling is green.**
