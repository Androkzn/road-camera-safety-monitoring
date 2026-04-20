# Plan B — Architectural improvements

**Theme:** right the foundations.
**Horizon:** long — items are sized in sprints / months for a small team.
**Read order:** [Plan A](plan-a-pragmatic.md) is a prerequisite, not a competitor. Several items here become safe only once Plan A has landed and tests exist.

Each work item carries:

- **Observed** — citation in the codebase.
- **Why it matters** — concrete impact.
- **Options** — 2–4 ways to address.
- **Trade-offs** — what each option costs / gives up.
- **Recommended** — the option I would pick.
- **Effort** — S / M / L (relative to Plan A's bigger items).
- **Risk** — low / medium / high.
- **Files touched** — concrete paths.
- **Depends on** — prerequisite items, including Plan A.

> **Per the project user rule:** lint / type-check / formatter changes are gated on explicit approval.

---

## B1. Pipeline / Gate split of `_on_frame`

**Observed.** [backend/server.py:1396–1832](../../backend/server.py) — `_on_frame` is a 430-line function executing 16 numbered gates inline (YOLO → quality → ego → scene → track-history update → interactions → depth gate → convergence gate → ego-relative motion → pair TTC → approach scrub → quality-adjusted classify → per-type floors → cooldown → episode open/update → idle-flush). Comments warn `do not short-circuit these gates — each one exists to kill a specific class of false positive`.

**Why it matters.** The system's correctness lives in this function. Gate 11 cannot be tested independently of gates 1–10. Any change has to run end-to-end through `tests/test_core.py`. Adding a 17th gate means editing the same function.

**Options.**
- **(a)** Define a `Gate` protocol (`run(ctx: GateContext) -> GateContext | None`); one file per gate under `backend/pipeline/gates/`. Pipeline iterates: `for gate in gates: ctx = gate.run(ctx) or break`.
- **(b)** Keep `_on_frame` monolithic but extract each numbered block into a private function in the same file with a `GateContext` dataclass for shared inputs.
- **(c)** Leave.

**Trade-offs.**
- (a) maximum testability, reorderability, per-gate metrics. Risk: someone reorders gates blindly and the false-positive classes the comments warn about return. Needs documentation that ordering is part of the contract, not an implementation detail.
- (b) half the win at a tenth of the risk. Each gate is a function with named inputs/outputs but lives next to its neighbours.
- (c) keeps every pipeline edit expensive.

**Recommended.** **(b) first** as a stepping stone (lands without changing module boundaries); **(a)** once each gate has at least one regression test pinned from `tests/test_core.py`.

**Effort.** L (3–4 weeks for the (b) → (a) sequence). **Risk.** medium — the pipeline IS the product.

**Files touched.**
- (b): `backend/server.py` `_on_frame` becomes a thin orchestrator; new helpers in same file or `backend/core/pipeline.py`.
- (a): new package `backend/pipeline/` with `gates/quality.py`, `gates/ego.py`, `gates/scene.py`, `gates/depth.py`, `gates/convergence.py`, `gates/motion.py`, `gates/ttc.py`, `gates/quality_adjust.py`, `gates/cooldown.py`, `gates/episode.py`. `Pipeline` class in `pipeline/__init__.py`.

**Depends on.** **Plan A item A6** (router extraction — `_on_frame` is easier to refactor when `server.py` is no longer 4,000 lines). **Plan B item B6** (Vitest? no — this is backend; the equivalent is `tests/test_core.py` regression coverage per gate, written *before* the (a) split lands).

---

## B2. `pydantic-settings` for config

**Observed.** [backend/config.py](../../backend/config.py) is 598 lines of `os.getenv("ROAD_X", default)` — ~70 env vars read at import time. Zero validation. Typo in `ROAD_TARGET_FPS` silently keeps the default.

**Why it matters.** Production misconfigurations are the silent kind: `ROAD_TARGET_FBS=4` boots happily and runs at the default 2 FPS forever.

**Options.**
- **(a)** `pydantic_settings.BaseSettings` — typed fields, validation at import, fail loud, integrates with FastAPI/OpenAPI docs.
- **(b)** Hand-rolled validator function called from `lifespan`.
- **(c)** Leave.

**Trade-offs.** (a) one new dependency; canonical pattern for FastAPI projects; readable diff (each field becomes a typed attribute with a `Field(default=..., description=...)`). (b) avoids the dependency but re-implements 80% of pydantic-settings poorly. (c) keeps silent default bugs.

**Recommended.** **(a).**

**Effort.** M (1 week for the migration + a release-note "no behaviour change" callout). **Risk.** medium — anyone running with a typo'd env var today silently uses the default; after this, they get a startup error. That is the *point* but it needs to be communicated.

**Files touched.** `backend/config.py` (rewrite as a `Settings` class), every module that imports constants from it (~30 files — all single-line import changes; tests catch wiring issues).

**Depends on.** None.

---

## B3. Full OpenAPI → TypeScript codegen

**Observed.** Plan A item A5 covers the top 5 payloads. The other 48 routes still rely on `frontend/src/shared/lib/adminApi.ts` and hand-mirrored types.

**Why it matters.** Permanent fix for FE/BE drift; removes most of the hand-written API plumbing.

**Options.**
- **(a)** OpenAPI codegen via `openapi-typescript-codegen` or `orval` — generates both types and a typed fetch client. Replaces most of `shared/lib/adminApi.ts` plumbing.
- **(b)** Manual Pydantic models per handler, no codegen. (Plan A approach extended.)
- **(c)** GraphQL layer over the existing handlers.

**Trade-offs.** (a) eliminates drift permanently; every handler needs `response_model=`; one new build step. (b) gets type safety on the backend without reaching the FE. (c) over-engineering for a single FE consumer.

**Recommended.** **(a).**

**Effort.** L (2–3 weeks). **Risk.** medium — every route needs `response_model=` and the FE imports change from hand-written types to generated ones.

**Files touched.**
- All 53 backend route handlers gain `response_model=`.
- New: `frontend/scripts/codegen.sh`, `frontend/src/shared/api/generated/` (committed).
- Removed/shrunk: `frontend/src/shared/lib/adminApi.ts`, `frontend/src/shared/lib/fetchClient.ts`, `frontend/src/shared/types/common.ts`, every `features/*/api.ts`.

**Depends on.** **Plan A A5** (top 5 already migrated and proven), **Plan A A6** (routers extracted so `response_model=` adds aren't tangled with route relocation).

---

## B4. Multi-source perception throughput

**Observed.** [backend/server.py](../../backend/server.py) holds one `state.model` shared across `StreamSlot`s; each slot calls `model.track(frame, persist=True, ...)` per frame at `TARGET_FPS=2`. ByteTrack IDs share a namespace through `persist=True` across cameras (potential ID collision); no batching.

**Why it matters.** Multi-camera deployments are the common case; current shape doesn't batch. Track-ID collisions across cameras are a latent correctness bug.

**Options.**
- **(a)** Batch `model.track([f1, f2, ...])` per tick across slots; per-slot tracker config files (`tracker=botsort_slot1.yaml`) so ByteTrack state stays isolated per camera.
- **(b)** Per-slot model instance — eliminates ID collisions but multiplies VRAM/RAM by N.
- **(c)** Optional ONNX export (`yolov8n.onnx` via `ultralytics export`) gated behind `ROAD_YOLO_BACKEND=onnx` for CPU deployments. *Speedup is implementation-dependent — needs benchmarking before any claim.*
- **(d)** Drop `persist=True` and run a custom tracker per slot.

**Trade-offs.** (a) one model load; batched throughput; biggest win for multi-camera; needs careful per-slot tracker config. (b) eliminates ID collisions but costs ×N VRAM. (c) deployment-target-dependent; should not commit without measurement. (d) requires re-implementing tracker logic.

**Recommended.** **(a)** primarily; **(c)** opt-in via env flag for CPU deployments — and only after a benchmark in `tools/`.

**Effort.** L (2 weeks for (a); +1 week for (c) including the benchmark harness). **Risk.** medium for (a); medium for (c).

**Files touched.** `backend/core/detection.py`, `backend/server.py` (`_on_frame` becomes a tick-batched dispatcher; needs B1 (b) at minimum). New: `backend/core/tracker.py` (per-slot tracker factory), `tools/bench_yolo.py` (benchmark harness).

**Depends on.** **B1 (b) at minimum** so `_on_frame` is structured enough to batch across slots.

---

## B5. Cross-feature client state store

**Observed.**
- [shared/lib/adminApi.ts:35, 46](../../frontend/src/shared/lib/adminApi.ts) — `setAdminToken` / `clearAdminToken` dispatch `admin-token-changed`; consumers subscribe via `window.addEventListener` (see `shared/hooks/useAdminToken.ts`).
- [features/admin/AdminPage.tsx:60](../../frontend/src/features/admin/AdminPage.tsx) — dispatches `admin-focused-id-changed` on every change.

**Why it matters.** Works, but is an ad-hoc DOM event bus. Surprising to new contributors. No way to introspect the bus or persist selectively.

**Options.**
- **(a)** Replace with Context providers (`AdminTokenProvider`, `FocusedSourceProvider`). Consistent with existing `WatchdogContext` / `DialogProvider`.
- **(b)** Replace with a Zustand store. Selector granularity, persist middleware, devtools.
- **(c)** Leave.

**Trade-offs.** (a) zero new deps; Context re-renders all consumers on every change (acceptable at the rates we have here). (b) selector granularity; new dep (~1 KB); learning cost. (c) keeps DOM events as state.

**Recommended.** **(a)** for low-frequency state (token, focused id). Reach for Zustand only if a future profile shows Context re-renders hurting frame budgets.

> *Plan A item A3 already extends the Context pattern for SSE; B5 is "do the same for the remaining DOM-event leaks".*

**Effort.** S (2–3 days). **Risk.** low.

**Files touched.** `frontend/src/app/providers.tsx`, `shared/lib/adminApi.ts` (token getters/setters move into the provider), `shared/hooks/useAdminToken.ts` (becomes `useAdminTokenCtx`), `features/admin/AdminPage.tsx`.

**Depends on.** **A3.**

---

## B6. Frontend test harness

**Observed.** [frontend/package.json](../../frontend/package.json) declares no test runner (`scripts: { dev, build, preview }`). No Vitest, no Jest, no RTL, no Playwright. Backend has `tests/` with real coverage; frontend has none.

**Why it matters.** Plan A's biggest items (A1, A4, A6 indirectly) refactor critical UI without a safety net.

**Options.**
- **(a)** Vitest + React Testing Library — start with the highest-leverage units: `useEventStream`, `useLiveSources`, `EventCard`, the `useSettingsDraft` extracted in A1.
- **(b)** Playwright end-to-end only — high signal but slow + brittle.
- **(c)** No FE tests; rely on TypeScript + manual review.

**Trade-offs.** (a) cheap unit tests for the units that change most; biggest ROI for the planned refactors. (b) high signal but every refactor risks breaking 5 selectors. (c) keeps refactors risky.

**Recommended.** **(a).** Add Playwright for cross-page flows (settings apply → SSE event → dashboard refresh) only after Vitest is established.

**Effort.** M (1 week to wire + initial test set). **Risk.** low.

**Files touched.** `frontend/package.json` (add devDeps + `test` script), `frontend/vitest.config.ts` (new), `frontend/src/setupTests.ts` (new), `frontend/src/**/__tests__/*.test.ts(x)` (initial set: `useEventStream`, `useLiveSources`, `EventCard`).

**Depends on.** None — can land before A1 to provide a safety net for the decomposition.

---

## B7. CI gates: type / lint / test

**Observed.** Today: `make lint` is `py_compile`. No CI runs `mypy`, `ruff`, `tsc --noEmit`, or any test runner on PR.

**Why it matters.** Every Plan A and B item ships behind a "trust the diff" review. CI gates make the wins permanent.

**Options.**
- **(a)** `mypy --strict` repo-wide + `ruff` + `tsc --noEmit` + `pytest` + `vitest` in CI on every PR.
- **(b)** Same, but warning-only for the first month while contributors get used to it.
- **(c)** Stay manual.

**Recommended.** **(b)** for one month → **(a)** after.

> **Per the user rule:** I will not add or run linters/type-checkers without explicit approval.

**Effort.** M (1 week to wire + the first round of fixes). **Risk.** low to medium (depending on the size of the initial mypy backlog).

**Files touched.** `pyproject.toml`, `Makefile`, `.github/workflows/ci.yml` (new or extended), `frontend/package.json`.

**Depends on.** **A10** (mypy allow-list grown to a meaningful surface), **B6** (Vitest exists), **B2** (`pydantic-settings` removes a class of `Optional[str]`-from-`os.getenv` noise).

---

## Suggested order of execution

Plan B is the second half of a year of work, sequenced after Plan A.

1. **B6** (1 week). Land first so every later item has a safety net.
2. **B2** (1 week). Standalone; flushes a class of silent-default bugs.
3. **B1 (b)** (2 weeks). Extract `_on_frame` into named gate-functions in the same file. Land regression tests per gate while doing this.
4. **B5** (3 days). Pair with the FE test harness from B6.
5. **B3** (2–3 weeks). OpenAPI codegen — biggest FE win after Plan A.
6. **B1 (a)** (2 weeks). With per-gate tests now in place from step 3, lift each gate into its own file under `backend/pipeline/gates/`.
7. **B4 (a)** (2 weeks). Batched `model.track([...])`; per-slot tracker.
8. **B7** (1 week). Turn on CI gates (warn-only for one month).
9. **B4 (c)** (1 week, optional). ONNX export behind `ROAD_YOLO_BACKEND=onnx`, gated on benchmark results.

**Total horizon for one engineer:** ~3 months. For two engineers in parallel (BE / FE split): ~6 weeks.

---

## What this plan deliberately does not do

- Does not move to a separate edge / cloud microservice split. The repo's current single-process edge + optional cloud receiver is the right shape for an edge product; a microservice split would add ops cost without changing the safety story.
- Does not introduce GraphQL. One FE consumer, REST is fine.
- Does not introduce SSR / Next.js. The product is an admin SPA served from the FastAPI process — that is the deployment story per [CLAUDE.md](../../CLAUDE.md).
- Does not introduce a state library bigger than Zustand/Context. Redux is overkill at this size.

---

## Cross-reference — Plan A items this plan depends on

| Plan B item | Requires from Plan A |
| --- | --- |
| B1 (b) → (a) | A6 (router extraction so `_on_frame`'s neighbourhood is calmer) |
| B3 (full OpenAPI codegen) | A5 (top 5 payloads already typed), A6 |
| B4 (batching) | B1 (b) at minimum |
| B5 (state store) | A3 (Context pattern already extended for SSE) |
| B7 (CI gates) | A10 (mypy allow-list), B6 (Vitest exists) |
