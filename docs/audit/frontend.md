# Frontend audit — `frontend/src/`

**Scope:** React 19 + Vite + TanStack Query + react-router under `frontend/src/`.
**Method:** Read every page and every cross-cutting hook, counted lines per file, traced data flow from `EventSource` / `fetchJson` through TanStack Query into the components, inspected every `setInterval` and `useSSE` call site. Findings cite the exact path + line.

Each finding follows the same template:

> **Observed** → file path + line range + the pattern actually present.
> **Why it matters** → concrete impact.
> **Options** → 2–4 ways to address.
> **Trade-offs** → what each option costs / gives up.
> **Recommendation** → the option I would pick *for this codebase's stage*.

## Strengths to credit first

So this reads as analytical, not as a complaint sheet:

- **Already feature-based.** [frontend/src/features/](../../frontend/src/features) is split into `admin/`, `dashboard/`, `monitoring/`, `settings/`, `tests/`, `validation/`, `watchdog/` — each with co-located `components/`, `hooks/`, and `api.ts`. The skeleton is right.
- **Strong TS baseline.** [tsconfig.app.json](../../frontend/tsconfig.app.json) has `"strict": true` plus `"noUncheckedIndexedAccess": true`. That's a real choice, not the default.
- **Routes are already lazy-loaded with error boundaries.** [frontend/src/app/router.tsx](../../frontend/src/app/router.tsx) wraps every route in `<ErrorBoundary><Suspense>` and uses `React.lazy` per page. Code-splitting and route isolation are not missing.
- **TanStack Query is wired sensibly.** [shared/lib/queryClient.ts](../../frontend/src/shared/lib/queryClient.ts) sets `staleTime: 5_000`, `refetchOnWindowFocus: true`, `retry: 1` — appropriate defaults for a real-time ops console.
- **Provider composition is explicit.** [shared/lib/queryClient → BrowserRouter → WatchdogProvider → DialogProvider](../../frontend/src/app/providers.tsx) — provider order is documented in the file's header comment with the reason.
- **Working primitive set.** `shared/ui/` has `Button`, `Input`, `Card`, `Section`, `Tabs`, `Skeleton`, `EmptyState`, `Spinner`, `Pill`, `Dot`, `Tag`, `RiskBadge`, `Dialog`, `ErrorBoundary`. Foundation is fine; the issue is missing *composites*.

## File size ranking (top of the list)

```
431  features/settings/SettingsPage.tsx          ← primary maintainability issue
341  features/admin/components/MultiSourceGrid.tsx
340  shared/types/common.ts                      ← hand-mirrored backend contract
323  features/settings/components/Tunable.tsx
301  features/validation/components/EventsPanel.tsx
294  features/watchdog/components/WatchdogDrawer.tsx
263  shared/events/EventDialog.tsx
250  features/admin/hooks/useLiveSources.ts
246  features/dashboard/DashboardPage.tsx
212  shared/ui/Dialog.tsx
208  features/monitoring/MonitoringPage.tsx       ← smaller than expected; secondary concern
206  features/settings/constants.ts
201  features/admin/AdminPage.tsx
```

The case for extracting inline pieces in `SettingsPage` and `MultiSourceGrid` is **not** primarily re-render cost. It is: testability in isolation, reuse across features, scannability in code review, splittable ownership across engineers.

---

## 1. Type safety

### 1.1 Backend contract is hand-mirrored

**Observed.** [frontend/src/shared/types/common.ts](../../frontend/src/shared/types/common.ts) is **340 lines** of TypeScript shadowing dicts that the FastAPI handlers in [road_safety/server.py](../../road_safety/server.py) build by hand (e.g. `admin_health()` at line 3279). Comments inside the TS file even acknowledge it: `Mirrors JSON shapes produced by FastAPI handlers`.

**Why it matters.** When backend renames `frames_processed` to `processed_frames`, TypeScript stays green; runtime breaks. The 340 lines also bloat the file you have to scroll through to find anything.

**Options.**
- **(a)** Pydantic models for the top 5 payloads + a generator (`fastapi-pydantic-to-typescript`) emitting `frontend/src/shared/types/generated.ts`. Keep the rest hand-maintained.
- **(b)** Full OpenAPI codegen via `openapi-typescript-codegen`/`orval` — eliminates `fetchClient`/`adminApi` plumbing too.
- **(c)** Leave as-is.

**Trade-offs.**
- (a) one PR, ~5 model files, low blast radius. Doesn't reach the other 48 routes.
- (b) permanent fix, removes most of `shared/lib/adminApi.ts` boilerplate, but every backend handler needs `response_model=`. Bigger change.
- (c) keeps silent drift bugs.

**Recommendation.** **(a)** in Plan A; **(b)** in Plan B once backend handlers are decomposed.

### 1.2 A few `unknown` / `Record<string, unknown>` leaks at the boundary

**Observed.**
- `validate(diff: Record<string, unknown>)` in [features/settings/api.ts](../../frontend/src/features/settings/api.ts).
- `body: unknown` in `AdminApiError` in [shared/lib/adminApi.ts:69](../../frontend/src/shared/lib/adminApi.ts).
- `setQueryData` callbacks lose their generic in a few places.

**Why it matters.** Acceptable at the network boundary, but `Record<string, unknown>` for the settings draft means key-typo bugs survive the type checker. The value of the strict tsconfig is partially undermined here.

**Options.** (a) Type the draft as `Partial<EffectiveSettingsValues>` (derived from generated types from item 1.1). (b) Keep loose typing at the boundary, fix downstream.

**Recommendation.** **(a)**, dependent on 1.1 landing first.

---

## 2. Modularity & god components

### 2.1 `SettingsPage.tsx` — the primary FE maintainability issue

**Observed.** [frontend/src/features/settings/SettingsPage.tsx](../../frontend/src/features/settings/SettingsPage.tsx) is **431 lines**. The page header docstring brags it was previously 1,564 (good progress!) but at 431 it still owns:

- Three feature hooks (`useSettings`, `useImpact`, `useSettingsTemplates`) plus three cross-cutting hooks (`useAdminToken`, `useLiveStatus`, `useLiveSources`, `useWatchdogCtx`, `useDriftCount`).
- Three dialog flows: `doApply` (lines 112–216), `doRollback` (218–255), `doApplyTemplate` (257–300). Each is ~50–100 lines with `setSubmitting`/`setApplyResult`/`setValidationErrors`/`setWarnings` orchestration plus error-class branching (`isPrivacyConfirmRequired`, `isAdminAuthFailure`, status 409, status 429).
- Draft state (`draft`, `setDraft`), validation state (`validationErrors`, `warnings`, `applyResult`).
- The `dirtyKeys` and `errorByKey` and `groupedSpecs` `useMemo`s.
- Three `console.groupCollapsed` / `console.info` / `console.warn` blocks inline.

**Why it matters.** This is what "god component" looks like in 2026 — it doesn't render 800 lines of JSX, it owns 300 lines of orchestration. The cost shows up at review time (one PR touches half the file), at test time (cannot exercise the apply pipeline without rendering the page), and at onboarding (a contributor must read the whole file to make a one-line change).

The strongest argument for splitting this is **not** re-render cost. It is: testability in isolation, reuse, scannability, easier review, splittable ownership.

**Options.**
- **(a)** Light extraction: lift the 3 dialog flows into `useApplyFlow` / `useRollbackFlow` / `useTemplateFlow` hooks under `features/settings/hooks/`. Page shrinks ~150 LOC.
- **(b)** Also extract draft state + validation: add `useSettingsDraft` (`{ draft, setKey, dirtyKeys, errorByKey, reset }`) and move `extractValidationErrors` / `isPrivacyConfirmRequired` into the new hook's module.
- **(c)** Full split: page becomes a `<SettingsLayout>` composer ≤ 100 LOC; every section (TunablesColumn, TemplatesCard, BaselineCard, ImpactCard, LivePreviewCard) is its own subtree with its own hook.

**Trade-offs.**
- (a) one PR, low risk, marginal readability win — page goes from 431 → ~280.
- (b) doubles the win at moderate risk; the apply pipeline orchestration that already had one painful refactor needs care.
- (c) highest payoff but risks regressing apply/rollback orchestration without tests in place.

**Recommendation.** **(b).** 80% of the value at 30% of the risk. (c) belongs in Plan B once Vitest is wired.

### 2.2 `MultiSourceGrid.tsx` co-locates `StreamTile`

**Observed.** [features/admin/components/MultiSourceGrid.tsx](../../frontend/src/features/admin/components/MultiSourceGrid.tsx) is **341 lines**. `StreamTile` (lines 21–172) is defined inline as a sibling component before the exported grid component. Four `useEffect`s plus a "safety belt" timeout, plus `confirm` dialog plumbing.

**Why it matters.** `StreamTile` is non-trivial (per-tile error recovery, confirm dialog, focus toggle, detection toggle, status dot, paused badge…). Co-locating it makes the grid file 341 lines instead of two ~170-line files.

**Options.** (a) Move `StreamTile` to `features/admin/components/StreamTile.tsx`. (b) Leave.

**Recommendation.** **(a).** S effort. The components are at the same abstraction level; one file each is cleaner.

### 2.3 Other inline / oversized files

- [features/settings/components/Tunable.tsx](../../frontend/src/features/settings/components/Tunable.tsx) (323 LOC) defines a `TunableContext` plus type-specific `TunableInput*` variants inline. Same recommendation as 2.2 — one file per variant.
- [features/validation/components/EventsPanel.tsx](../../frontend/src/features/validation/components/EventsPanel.tsx) (301 LOC) and [features/watchdog/components/WatchdogDrawer.tsx](../../frontend/src/features/watchdog/components/WatchdogDrawer.tsx) (294 LOC) are within tolerable range; tackle only if touched for another reason.

---

## 3. UI / reusable components

### 3.1 Two near-duplicate event cards

**Observed.**
- [shared/events/EventCard.tsx](../../frontend/src/shared/events/EventCard.tsx) — 170 LOC, "public-facing".
- [features/admin/components/AdminEventCard.tsx](../../frontend/src/features/admin/components/AdminEventCard.tsx) — 176 LOC, "admin-only, denser".

Both import `RiskBadge` + `Tag` from `shared/ui`, both use `normalizeThumbnail` + `formatWallTime` + `humanEventType` from `shared/lib/format`, both render a thumbnail + RiskBadge + event-type + time row + kinematic tags row + narration. The differences: enrichment row + `FeedbackButtons` (public), orientation + taxonomy badges (admin), CSS module names.

**Why it matters.** The next event-card change has to land in two files. New variant requirements (compact row in `MonitoringPage`?) → third file.

**Options.**
- **(a)** Merge into `<EventCard variant="public" | "admin" | "compact">` in `shared/events/`. Children compose with slot-style props (`actions`, `header`, `footer`).
- **(b)** Extract a shared `<EventCardBody>` and keep two thin wrappers.
- **(c)** Leave separate.

**Trade-offs.** (a) one source of truth; risk of variant API growing too wide. (b) less invasive but keeps the "two roughly equal cards" smell. (c) divergence keeps growing.

**Recommendation.** **(a).** Three variants is a manageable axis; document each variant's intent in the file header.

### 3.2 Open-coded controls that should be primitives

**Observed.**
- Filter bar in [features/dashboard/DashboardPage.tsx:161–217](../../frontend/src/features/dashboard/DashboardPage.tsx) — two `<select>` dropdowns, a checkbox, a clear button, a count span — all hand-rolled.
- Detection toggle in [features/admin/components/MultiSourceGrid.tsx:158–168](../../frontend/src/features/admin/components/MultiSourceGrid.tsx) — `<input type="checkbox">` plus label, no shared `<Toggle>` primitive.
- "Show low risk" checkbox appears in `AdminPage`, `DashboardPage`, `MonitoringPage` independently.

**Why it matters.** Three different look-and-feels for the same control = visual inconsistency + three places to change when the design system updates.

**Options.**
- **(a)** Add `<Select>`, `<Checkbox>`, `<Toggle>` to `shared/ui/`; add an `<EventFilterBar>` composite to `shared/events/`.
- **(b)** Add only the composite (`<EventFilterBar>`); leave low-level controls open-coded.
- **(c)** Leave.

**Recommendation.** **(b) first** — the composite has 3 clear call sites. Add `<Select>` / `<Toggle>` later, only when 3+ unique consumers actually exist outside the filter bar (avoid abstraction-for-its-own-sake).

### 3.3 Three duplicated 1-second uptime tickers

**Observed.** Identical effect in three files:

```ts
useEffect(() => {
  if (!startedAt) return;
  const tick = () => setUptimeSec(Date.now() / 1000 - startedAt);
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}, [startedAt]);
```

at [features/admin/AdminPage.tsx:86–92](../../frontend/src/features/admin/AdminPage.tsx), [features/dashboard/DashboardPage.tsx:102–109](../../frontend/src/features/dashboard/DashboardPage.tsx), [features/admin/components/SelectedStreamHeader.tsx:55–60](../../frontend/src/features/admin/components/SelectedStreamHeader.tsx). Plus another tick at [features/settings/components/ImpactCard.tsx:36](../../frontend/src/features/settings/components/ImpactCard.tsx).

**Why it matters.** Three timers running simultaneously when two pages are split-screen (or just open in tabs); three places to change the format.

**Options.** (a) Extract `useUptime(startedAtSec)` in `shared/hooks/`. (b) Leave.

**Recommendation.** **(a).** S effort, removes 3 copies of the same effect.

### 3.4 `TopBar` is reused, but each page recomputes its props

**Observed.** Every page does:

```ts
const { status: wdStatus } = useWatchdogCtx();
const driftCount = useDriftCount();
// ...
<TopBar errorCount={wdStatus?.by_severity?.error ?? 0} driftCount={driftCount} ... />
```

at [AdminPage.tsx](../../frontend/src/features/admin/AdminPage.tsx), [DashboardPage.tsx](../../frontend/src/features/dashboard/DashboardPage.tsx), [SettingsPage.tsx](../../frontend/src/features/settings/SettingsPage.tsx), [MonitoringPage.tsx](../../frontend/src/features/monitoring/MonitoringPage.tsx).

**Why it matters.** Adding a new TopBar metric (e.g. queue depth) means editing every page.

**Options.** (a) Wrap `TopBar` in a `<PageChrome>` that pulls from contexts internally; pages pass only page-specific children. (b) Leave.

**Recommendation.** **(a).** S effort, central place for cross-cutting indicators.

---

## 4. Network performance / wasteful traffic

### 4.1 Pages overlap on `/api/live/status` + `/api/admin/health`

**Observed.**
- `useLiveStatus` polls every 5 s ([shared/hooks/useLiveStatus.ts:16](../../frontend/src/shared/hooks/useLiveStatus.ts)).
- `useAdminHealth` polls every 4 s ([features/admin/hooks/useAdminHealth.ts:8](../../frontend/src/features/admin/hooks/useAdminHealth.ts)).
- Dashboard mounts `useLiveStatus`. Admin mounts `useAdminHealth`. **Settings mounts both** ([SettingsPage.tsx:63–64](../../frontend/src/features/settings/SettingsPage.tsx)).
- Backend serves both endpoints from largely-overlapping data ([road_safety/server.py:2777, 3279](../../road_safety/server.py)).

**Why it matters.** This is the canonical "too many API calls for not important UI" pattern. The Settings page polls *both* every 4–5 s primarily to feed the TopBar uptime pill — a UI element that nobody is checking second-by-second.

**Options.**
- **(a)** Slow the polls for low-value UI: 4 s → 10 s, 5 s → 15 s on pages that don't need second-precision.
- **(b)** Have Settings use only one of the two.
- **(c)** Add a backend `/api/live/snapshot` superset endpoint (see backend audit 4.1).
- **(d)** Add `ETag` and 304 short-circuit (server change).

**Trade-offs.** (a) one-line change per hook, instant relief. (b) keeps the 4 s/5 s but removes one of the two on Settings. (c)/(d) require backend work.

**Recommendation.** **(a) + (b)** in Plan A; (c) in Plan B.

### 4.2 Two FE hooks bypass TanStack Query with raw `setInterval`

**Observed.**
- [features/settings/hooks/useSettings.ts:99–104](../../frontend/src/features/settings/hooks/useSettings.ts) — `setInterval(refresh, POLL_MS)` where `POLL_MS = 15_000`.
- [features/settings/hooks/useImpact.ts:49](../../frontend/src/features/settings/hooks/useImpact.ts) — same pattern.

**Why it matters.** Raw `setInterval` doesn't pause when the tab is hidden, doesn't dedup across consumers, doesn't cancel on unmount-during-flight, doesn't share the cache. The rest of the FE uses TanStack Query and benefits from all of these for free; these two hooks pay the cost in custom plumbing without the upside.

**Options.**
- **(a)** Migrate both to `useQuery` with `refetchInterval: 15_000`.
- **(b)** Keep `setInterval` but add `document.visibilitychange` gating manually.
- **(c)** Leave.

**Trade-offs.** (a) consistent with the rest of the FE; eliminates a class of polling/cache/retry boilerplate; gets focus refetch + cancellation for free. (b) re-implements TanStack behaviour. (c) wastes background bandwidth.

**Recommendation.** **(a).** Note the scope: TanStack Query is for HTTP request/response. **Do not** fold SSE (`useSSE` / `useEventStream`) into TanStack — push streams are a different category and stay on their own provider (item 5.1 below).

### 4.3 SSE is per-page instead of per-app

**Observed.** [shared/hooks/useEventStream.ts](../../frontend/src/shared/hooks/useEventStream.ts) creates an `EventSource` whenever a component mounts the hook. AdminPage mounts it; DashboardPage mounts it. Nothing prevents two simultaneous connections (split-screen, two tabs, or an embedded panel).

**Why it matters.** Doubles SSE load on the server when both pages are open in different tabs. Each page also keeps its own rolling 100-event buffer.

**Options.**
- **(a)** Hoist into `EventStreamProvider` (Context) wired in [src/app/providers.tsx](../../frontend/src/app/providers.tsx); consumers read via `useEventStreamCtx()`. Matches existing `WatchdogContext` / `DialogProvider` pattern.
- **(b)** Move events into a Zustand store; consumers read with selectors.
- **(c)** Leave.

**Trade-offs.** (a) zero new dependencies, consistent with the rest of the FE. (b) selector granularity (avoid re-rendering all consumers on every event), but new dependency. (c) doubles SSE load when ≥2 pages mount the hook.

**Recommendation.** **(a).** Adopt Zustand only when selector granularity actually hurts — none of the consumer counts here justify it.

### 4.4 `useLiveSources` fires N+1 requests on bulk actions

**Observed.** [features/admin/hooks/useLiveSources.ts](../../frontend/src/features/admin/hooks/useLiveSources.ts) — `start` / `pause` / `setDetection` / `add` / `remove` each call `await refresh()` *and* the hook polls `/api/live/sources` every 5 s. Operator clicking "Start all" on N sources fires N optimistic updates + N full list refreshes.

**Why it matters.** Multi-camera deployments + impatient operator → request storm.

**Options.**
- **(a)** Convert mutations to `useMutation` and batch a single `qc.invalidateQueries` after the bulk action settles.
- **(b)** Coalesce: queue refresh requests in a 250 ms window.
- **(c)** Leave.

**Recommendation.** **(a).** Idiomatic TanStack; clean optimistic-update story.

### 4.5 `StreamImage` polling has no cache headers

**Observed.** [features/admin/components/StreamImage.tsx:134](../../frontend/src/features/admin/components/StreamImage.tsx) polls `/admin/frame/{id}` every 400 ms in HTTP/1.1 mode by appending `?_=${Date.now()}` to bust caches. Server has no `ETag` / `Last-Modified` (see backend audit 4.3).

**Why it matters.** Re-fetches even when the perception thread hasn't produced a new frame.

**Options.** (a) Have the server stamp `ETag = slot._frame_ts`; FE sends `If-None-Match`; on 304 keep the current `<img>`. (b) Leave.

**Recommendation.** **(a)**, paired with backend item 4.3.

---

## 5. Hooks

### 5.1 `usePolling` is dead code

**Observed.** [shared/hooks/usePolling.ts](../../frontend/src/shared/hooks/usePolling.ts) exists but no consumer imports it — only `useSSE` uses raw timers (correctly so). Settings's `useSettings`/`useImpact` reach for `setInterval` directly instead of using `usePolling` (and they should use `useQuery` anyway, item 4.2).

**Recommendation.** Delete `usePolling.ts` once item 4.2 (`useSettings` / `useImpact` → `useQuery`) lands.

### 5.2 A few `eslint-disable react-hooks/exhaustive-deps`

**Observed.**
- [features/admin/hooks/useDetections.ts:99](../../frontend/src/features/admin/hooks/useDetections.ts) — disabled because the closure reads `stats.fps` but rebuilding on every `stats` change would defeat the FPS counter ref.
- [features/dashboard/DashboardPage.tsx:96–97](../../frontend/src/features/dashboard/DashboardPage.tsx) — disabled in the test-status auto-open effect.

**Why it matters.** Each disable is a small bet; enough of them and the rule loses meaning.

**Recommendation.** Audit each one when the surrounding hook is touched; replace the closure read with `useRef` or extract a `useEffectEvent` (React experimental) when stable.

### 5.3 `useEventStream` returns a ref's `.current` as state

**Observed.** [shared/hooks/useEventStream.ts:17, 49](../../frontend/src/shared/hooks/useEventStream.ts):

```ts
const countsRef = useRef({ total: 0, high: 0, medium: 0 });
// ...
return { events, perception, connected, counts: countsRef.current, clearEvents };
```

Components don't re-render on count changes — only via `events`. The fact that today every count change happens in the same callback as an `events` push masks the bug.

**Why it matters.** Subtle. If anyone ever updates counts without also pushing an event, consumers will silently see stale counts.

**Options.** (a) Move counts into `useState`. (b) Document the coupling and leave. (c) Derive counts from `events` in a `useMemo` in consumers.

**Recommendation.** **(c)** if the counts are cheap to compute (`O(events.length)` ≤ 100). Removes the trap.

---

## 6. State management

### 6.1 Cross-feature client state via `localStorage` + `CustomEvent`

**Observed.**
- [shared/lib/adminApi.ts:35, 46](../../frontend/src/shared/lib/adminApi.ts) — `setAdminToken` and `clearAdminToken` dispatch `admin-token-changed`; consumers subscribe via `window.addEventListener` (see `shared/hooks/useAdminToken.ts`).
- [features/admin/AdminPage.tsx:60](../../frontend/src/features/admin/AdminPage.tsx) — dispatches `admin-focused-id-changed` on every change; nobody subscribes to it as far as the search shows (vestigial?).

**Why it matters.** Works, but is an ad-hoc event bus. Surprising to new contributors. No way to introspect the bus.

**Options.**
- **(a)** Replace with Context provider (`AdminTokenProvider`).
- **(b)** Replace with Zustand store.
- **(c)** Leave.

**Trade-offs.** (a) consistent with existing `WatchdogContext` / `DialogProvider`; zero new deps. Re-renders all consumers on token change (low-frequency, fine). (b) selector granularity, persist middleware; new dep. (c) keeps DOM events as state.

**Recommendation.** **(a)** for low-frequency state (token, focused id). Reach for Zustand only when a profiled hot-spot demands it.

### 6.2 Server state vs client state — keep them separate

**Observed.** Server state correctly uses TanStack Query (apart from items 4.2/4.3). Client UI state is a mix of `useState` in pages, `localStorage`, and Context. There's no central principle.

**Recommendation (cross-cutting).** Document a one-pager: "Server state → TanStack Query. SSE → `EventStreamProvider`. Cross-feature client state → Context. Page-local UI state → `useState`." Lives at `docs/audit/state-strategy.md` (out of scope here; flag for future doc).

---

## Summary table — frontend findings → plans

| # | Finding | Plan A item | Plan B item |
| --- | --- | --- | --- |
| 1.1 | Hand-mirrored types | A5 | B3 |
| 1.2 | `unknown` leaks | depends on A5 | B3 |
| 2.1 | `SettingsPage` god component | **A1** | follow-on |
| 2.2 | `MultiSourceGrid` inline `StreamTile` | A1 (same PR) | — |
| 2.3 | Other oversized files | drive-by | — |
| 3.1 | Two event-card files | **A4** | — |
| 3.2 | Open-coded `<Select>` / `<Toggle>` / filter bar | A4 | — |
| 3.3 | Duplicated uptime tickers | A4 | — |
| 3.4 | `TopBar` props recomputed per page | A4 | — |
| 4.1 | `/live/status` + `/admin/health` overlap | **A7** | — |
| 4.2 | `useSettings` / `useImpact` bypass TanStack | **A2** | — |
| 4.3 | SSE per-page | **A3** | — |
| 4.4 | `useLiveSources` N+1 refresh | A8 | — |
| 4.5 | `StreamImage` no ETag | A7 (drive-by) | — |
| 5.1 | `usePolling` dead code | A2 (drive-by) | — |
| 5.2 | `eslint-disable` count | drive-by per touch | — |
| 5.3 | `countsRef.current` returned as state | drive-by | — |
| 6.1 | `CustomEvent` bus | A3 (extend pattern) | B5 |
| 6.2 | No documented state strategy | — | B6 |

The work-item descriptions, with effort + risk + files-touched tags, live in [plan-a-pragmatic.md](plan-a-pragmatic.md) and [plan-b-architectural.md](plan-b-architectural.md).
