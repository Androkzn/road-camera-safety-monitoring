# Backend Audit - 2026-04-20

**Scope:** `backend/` + `cloud/`  
**Code size:** 23,403 LOC (Python in `backend` + `cloud`)  
**Runtime shape:** FastAPI edge server + multi-source stream readers + YOLO/ByteTrack + LLM enrichment + cloud receiver

## 1. Executive Summary

The backend has strong domain logic and many good operational patterns, but maintainability and scale are constrained by a very large `server.py` and a few high-impact performance/correctness gaps in multi-source mode.

**Auth-boundary addendum (post-review):** An earlier version of this audit under-weighted the auth surface. Multiple **control** and **media** endpoints carry explicit `AUTH: public` docstrings ([server.py:3373](backend/server.py#L3373), [:3592](backend/server.py#L3592), [:3619](backend/server.py#L3619), [:3680](backend/server.py#L3680), [:3801](backend/server.py#L3801), [:3899](backend/server.py#L3899), [:3947](backend/server.py#L3947)). The project relies on "network-gated operator UI" as its security model - that is a deployment assumption, not a code property. If the perimeter is weak, an attacker can start/stop sources, add arbitrary stream URLs (SSRF vector), toggle the validator, trigger test runs, and stream live camera feeds. See BE-D12 - BE-D15 below for details. **Treat these as pre-production blockers, not refactor items.**

Top priorities:

1. **Close the auth boundary** on control + media + clip + add-source endpoints (BE-D12..D15).
2. Make event/perception metadata truly source-aware (avoid primary-slot leakage).
3. Split `server.py` into focused modules.
4. Remove unnecessary file and network overhead in watchdog/egress integrations.
5. Add stronger typed API contracts for core routes.
6. Add explicit model performance instrumentation and inference scheduling strategy.

## 1.1 Current State Update (refresh)

This section reflects the **current repository state** after post-audit implementation work.

### Completed since the original audit baseline

| Decision | Status | Evidence in repo |
|---|---|---|
| BE-D2.A/B (`server.py` decomposition + runtime extraction) | Done | `backend/server.py` is now a thin composition root (~119 LOC); runtime/pipeline logic moved into `backend/startup.py`, `backend/state.py`, and `backend/perception/*`. |
| BE-D12/13/14/15 auth + media + clip + SSRF hardening | Done | Control/media routes call auth guards; signed media URL flow is in `backend/security/signing.py`; clip endpoint uses auth + rate-limit in `backend/api/routers/live.py`; SSRF validator is enforced in `backend/api/routers/sources.py` via `backend/security/ssrf.py`. |
| BE-D6 Phase 1 typed API contracts | Done | `response_model=` is present on the target routes (`/api/live/status`, `/api/admin/health`, `/api/live/sources`, `/api/events/{id}`, `/chat`) with shared models in `backend/api/models.py`. |
| BE-D8 snapshot/atomic read direction | Done (Phase A/B intent) | `LiveState.snapshot()` and recent-event access helpers exist in `backend/state.py`; routes consume frozen snapshots/helpers instead of direct list mutation reads. |
| BE-D7 privacy primitive in compliance package | Done | Plate scrub helper now lives in `backend/compliance/privacy.py` and is imported from `backend/services/llm.py`. |
| BE-D4 HTTP client reuse | Done | Shared async clients with `_get_client()` + `aclose()` exist in `backend/integrations/edge_publisher.py` and `backend/integrations/slack.py`. |
| BE-D5.A stage timings | Done | Per-stage timing capture (`yolo`, `quality`, `ego`, `scene`, `emit`) is recorded and exposed in `/api/admin/health`. |
| Sprint 0 verification/tooling prerequisite | Done | Local checks pass: `make test-all` (BE + FE) and `make typecheck` are green in this workspace. |

### Partial / still open

| Decision | Status | Current note |
|---|---|---|
| BE-D16 bulk source control | Partial | `restart_all` exists; generalized bulk action surface is still limited. |
| BE-D11 overlapping status/health polling | Open | `/api/live/status` and `/api/admin/health` both remain active and overlapping. |
| BE-D3 watchdog/queue full-file I/O | Open | `watchdog` and edge queue paths still use full-file read/split/write patterns. |
| BE-D10 typed config schema (`pydantic-settings`) | Open | `backend/config.py` still relies on env parsing without `BaseSettings` schema enforcement. |
| BE-D9.B/C advanced scheduling/per-slot tracker architecture | Open (evidence-gated) | Warmup/timing visibility landed; deeper scheduling work remains intentionally deferred pending evidence. |
| BE-D1.C + BE-D6 Phase 4 strictness | Open (FE-coupled) | Removal of legacy proxy/extra-allow paths should wait for FE migration completion. |

## 2. What To Focus On First

**Sprint 0 (pre-production blockers — see §8 for tooling prerequisites):**

1. **Auth boundary.** Close the unauthenticated mutation surface (BE-D12), SSRF risk (BE-D15), clip DoS (BE-D14), and unauthenticated media streams (BE-D13). These ship **before** any refactor; every other item on this list assumes the trust boundary holds.

**Sprint 1+ (normal engineering work):**

2. **Correctness in multi-source context:** stop using primary-slot proxies where per-slot state is required (BE-D1). Close the state-lock gap on routes that read perception-thread state (BE-D8).
3. **Monolith reduction:** reduce `server.py` blast radius (BE-D2) — finish the router extraction the team already started.
4. **Type contracts:** formalize request/response schemas for critical endpoints (BE-D6). Pair the `LiveStateSnapshot` dataclass from BE-D8 with the Pydantic response model.
5. **Network and I/O efficiency:** avoid repeated full-file reads and per-call HTTP client creation (BE-D3, BE-D4).
6. **Model path scalability:** handle increased source count without unpredictable latency (BE-D5, BE-D9). Measure before scheduling; BE-D5.A ships before BE-D5.B is even considered.

## 3. Detailed Findings By Requested Area

**Historical note:** Sections 3-6 capture the **original audit-time findings** (baseline snapshot). Use §1.1 for the up-to-date implementation status.

### A) Type Safety

Strengths:

- Many modules are well-typed (`core/detection.py`, `services/watchdog.py`, `services/llm.py`, `api/settings.py`, `cloud/receiver.py`).
- Settings subsystem has a strong typed/validated store (`backend/settings_store.py`, `backend/settings_spec.py`).

Gaps:

- `server.py` still relies heavily on untyped dict payloads for event and response surfaces.
- Core routes return raw dicts without `response_model`, reducing contract clarity and generated-client quality.
- `/chat` accepts `body: dict` directly (`backend/server.py:2754-2771`) instead of a typed request model.

Recommendations:

- Introduce Pydantic response models for high-traffic routes first (`/api/live/status`, `/api/admin/health`, `/api/live/sources`, `/api/events/{id}`).
- Add typed `EventPayload` model/TypedDict shared across emit, SSE, and cloud publish.

### B) Modularity

Strengths:

- Clear package boundaries (`core`, `services`, `integrations`, `api`, `compliance`).
- Route extraction already started for settings and feedback.

Gaps:

- `backend/server.py` is 3,972 LOC and contains too many responsibilities: app wiring, lifecycle, per-frame pipeline, event emission, admin/public APIs, and multi-source orchestration.
- `server.py` currently defines 53 HTTP endpoints (`rg` count of `@app.get/post/delete/...`).

Recommendations:

- Continue route extraction by domain (`api/live.py`, `api/admin.py`, `api/events.py`).
- Move emission/pipeline/state into dedicated service/state modules.

### C) Massive Files

Largest backend files:

| File | LOC | Action |
|---|---:|---|
| `backend/server.py` | 3,972 | Must split by domain and runtime layer |
| `backend/services/watchdog.py` | 1,804 | Keep cohesive; optimize I/O paths |
| `backend/core/detection.py` | 1,375 | Keep cohesive; improve perf instrumentation |
| `backend/services/llm.py` | 1,063 | Keep cohesive; tighten observability and client lifecycle |
| `backend/services/drift.py` | 1,009 | Consider smaller policy/metrics modules |
| `backend/services/agents.py` | 885 | Split tool definitions from orchestration |
| `backend/core/validator.py` | 785 | Keep but segment comparison/reporting blocks |
| `backend/integrations/edge_publisher.py` | 722 | Optimize queue read/write and HTTP client reuse |
| `backend/integrations/slack.py` | 675 | Reuse HTTP client and bound in-memory buffers |
| `backend/api/settings.py` | 669 | Mostly cohesive |

### D) Network Performance (redundant/unnecessary calls)

Key findings:

- `watchdog.tail()` reads the entire watchdog file, then slices tail records (`backend/services/watchdog.py:799-833`), and `stats()` calls `tail(500)` (`:917-934`). This scales poorly with file growth.
- `edge_publisher.flush_once()` reads full queue file via `read_text().splitlines()` (`backend/integrations/edge_publisher.py:541-547`) and rewrites full file (`:580`, `:648`, `:669`) on flush paths.
- `edge_publisher.flush_once()` creates a new `httpx.AsyncClient` per flush (`backend/integrations/edge_publisher.py:612-615`).
- Slack sends and digest sends each create a new `httpx.AsyncClient` (`backend/integrations/slack.py:403`, `:526`).
- Frontend bulk stream controls currently amplify backend traffic by sending many per-source mutations and refreshes (backend impact from FE behavior).

Recommendations:

- Use incremental tail-reading (`deque`, buffered iterator) for watchdog and queue files.
- Keep long-lived async clients for edge publisher and Slack modules.
- Add jitter to backoff to reduce synchronized fleet retries.

### E) Model Performance

Current behavior:

- Model loaded once at startup (`backend/server.py:2214-2216`) and used on each frame in `_on_frame` (`backend/server.py:1396-1483`).
- Inference call is synchronous `detect_frame(state.model, frame)` in each stream callback (`backend/server.py:1482`, callback at `:1381-1392`).
- Detection uses `model.track(..., persist=True)` (`backend/core/detection.py:1123-1154`), which is good for track continuity.

Risks:

- As source count rises, multiple reader threads contend for one model instance with no explicit inference scheduler/backpressure.
- No explicit startup warmup step for model path.
- Missing per-source/per-stage latency metrics for YOLO, optical flow, scene classification, and emission.

Recommendations:

- Add an inference scheduler queue with bounded worker policy (single worker or controlled pool per device).
- Record stage timings and publish to admin health.
- Add model warmup call after load.

### F) State Management Improvements

Most important issue:

- Multi-source architecture exists, but some runtime and API paths still read legacy primary-slot proxies (`state.quality`, `state.reader`, `state.last_scene_ctx`) instead of the active slot.

Evidence:

- `LiveState` explicitly keeps legacy primary proxies (`backend/server.py:625-746`).
- `_emit_event` enrichment skip and perception state use `state.quality` (`backend/server.py:2094-2098`), not the event slot.
- Public/admin status endpoints use primary proxy fields (`backend/server.py:2777-2815`, `3279-3338`).

Impact:

- In multi-source deployments, events and health may show perception metadata from the wrong camera.

Recommendation:

- Thread `slot` through emission/status paths and expose both per-source and aggregate views.

## 4. Prioritized Issue List

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **BE-12** | **Critical** | **Control endpoints unauthenticated** (start/stop slots, add source, validator toggle, test run) | `server.py:3373,3680,3801,3947` |
| **BE-13** | **Critical** | **Live media/detection streams unauthenticated** (MJPEG, single-frame, admin-detections SSE) | `server.py:3592,3619,3899` |
| **BE-14** | **High** | **Expensive clip rendering endpoint public + DoS-able via cache miss** | `server.py:2974,3000,3043` |
| **BE-15** | **High** | **SSRF-style risk on `/api/live/sources` (arbitrary URL fetched by edge host)** | `server.py:3801,3827`; `server.py:1313`; `stream.py:154` |
| BE-1 | High | Primary-slot leakage in event/perception metadata under multi-source | `server.py:625-746`, `2094-2098`, `2777-2815`, `3279-3338` |
| BE-2 | High | `server.py` monolith creates high change risk and low velocity | `server.py` (3,972 LOC) |
| BE-3 | Medium | Queue/watchdog full-file read/write patterns may degrade at scale | `watchdog.py:799-833,917-934`; `edge_publisher.py:541-547,580,648,669` |
| BE-4 | Medium | Repeated HTTP client creation in Slack and edge publisher | `slack.py:403,526`; `edge_publisher.py:612-615` |
| BE-5 | Medium | No explicit inference scheduler/backpressure for multi-stream model contention | `server.py:1381-1392,1482` |
| BE-6 | Medium | Key routes still untyped dict responses without response models | `server.py` route handlers |
| BE-7 | Medium | Privacy primitive `_hash_and_strip_plate` lives in `services/llm.py`, not `compliance/` | `services/llm.py:732` |
| BE-8 | High | Routes read perception-thread state without acquiring `state.lock` | `server.py:2777,3279,2937,3964` |
| BE-9 | Medium | ByteTrack `persist=True` + single shared model → cross-camera track-ID collision risk; no warmup; `imgsz`/`half`/`device` unset | `core/detection.py:1140-1147` |
| BE-10 | Medium | `config.py` has no schema — 70 env vars read with no validation | `backend/config.py` (598 LOC) |
| BE-11 | Medium | `/api/live/status` and `/api/admin/health` overlap; Settings mounts both | `server.py:2777,3279` |

## 5. Showcase Framing (What This Demonstrates)

This plan is designed to showcase two capabilities:

1. **Code comprehension in complex systems:** identifying real correctness risks in multi-source runtime behavior.
2. **Pragmatic architecture judgment:** sequencing meaningful fixes before deep refactors.

Strong expertise signals to highlight:

1. Type-safety applied where contracts matter most (event payloads and API boundaries).
2. Performance reasoning across model, queue I/O, and HTTP integration paths.
3. State/concurrency reasoning around source ownership and lifecycle behavior.
4. Ability to choose phased modernization over all-at-once rewrites.

## 6. Decisions And Trade-Offs

Each decision follows the same shape: **Observation** (what the code shows), **Why it matters**, **Options** with trade-offs, **Recommendation**. The goal is to expose judgment grounded in the code, not hand out a checklist.

---

### BE-D1 - Primary-slot leakage under multi-source (BE-1, High)

**Observation.** [server.py:625-746](backend/server.py#L625) defines `LiveState` with legacy primary-slot proxies (`state.quality`, `state.reader`, `state.last_scene_ctx`) that co-exist with the newer `state.slots` map. The event-emission path still reads `state.quality` at [server.py:2094-2098](backend/server.py#L2094); `/api/live/status`, `/api/live/perception`, `/api/live/scene`, and `/api/admin/health` ([server.py:2777-2815](backend/server.py#L2777), [:3279-3338](backend/server.py#L3279)) return primary-slot data even when multiple slots are active.

**Why it matters.** In a 4-camera vehicle, an event from the rear camera can be annotated with the front camera's quality metrics. This is a correctness bug with real operational impact (wrong incident attribution, wrong health dashboards), not a perf issue.

**Options**

| Option | Trade-offs |
|---|---|
| A - Patch `_emit_event` only to resolve its slot from the event | Fast. Closes the most harmful surface (wrong data on emitted events). Leaves operator APIs still primary-biased. |
| B - Patch `_emit_event` + return per-source maps from live/admin routes (`{sources: {id: {...}}, primary: id}`); keep primary fields as legacy aliases for one release | Correctness fix across both surfaces. FE can migrate incrementally. Aliases become tech debt with no forcing function. |
| C - Remove primary proxies entirely in one release; break the FE that reads `status.quality` directly | Cleanest. Highest regression risk. Requires FE to migrate in lockstep. |

**Recommended: B in release N, C in release N+1 after FE migrates.** A alone leaves operator dashboards misleading; C alone is a flag day. B is the migration path that matches how FE-owned types evolve.

**Acceptance criteria.**
- For every test fixture with >1 `StreamSlot` active, the emitted event's `quality` / `scene` / `ego` fields correspond to the slot that produced the event (property-based test on `slot_id` round-trip).
- `/api/live/status` response includes a `sources: {[id]: {...}}` map alongside the legacy top-level fields; FE can read either.
- No new route reads `state.quality` / `state.reader` / `state.last_scene_ctx` directly - all per-source reads go through `state.slots[id]`.

**Rollout / rollback.**
- Ship behind `ROAD_PER_SOURCE_METADATA=true` env flag for release N; default-off preserves current behaviour.
- Observability: new watchdog finding `event_source_mismatch`; `_emit_event` metric `slot_resolution_method = primary | event_slot`.
- Rollback trigger: >1% of events show mismatched slot metadata in the first 24h after flip-on → flip flag off, keep old behaviour, investigate before re-try.
- Legacy primary-proxy aliases **stay** for at least release N+1. C (deprecation) only after FE audit confirms zero consumers read the legacy top-level fields.

---

### BE-D2 - `server.py` monolith and sibling oversized modules (BE-2, High)

**Observation.** [server.py](backend/server.py) is 3,972 LOC with 53 HTTP endpoints and six distinct responsibilities: FastAPI wiring, lifecycle, per-frame perception pipeline (`_on_frame` alone is ~434 LOC), event emission (`_flush_episode` + `_emit_event` at [:2094-2098](backend/server.py#L2094)), multi-source state (`Episode`, `StreamSlot`, `LiveState`), and both public + admin routes.

**Important framing:** the team has **already started** the extraction. Two of the 53 routes live in [backend/api/settings.py](backend/api/settings.py) (669 LOC) and [backend/api/feedback.py](backend/api/feedback.py). The other 51 are still inline in `server.py`. The pattern exists; it just wasn't finished. That makes "finish what's started" a better framing than "propose decomposition from scratch."

Three sibling modules also qualify for pure relocation with no behaviour change:
- **`services/watchdog.py` (1,804 LOC)** mixes rule checks, AI analyzer, storage, grouping, and the orchestrator. Split into `watchdog/{rules.py, ai.py, storage.py, fingerprint.py, orchestrator.py}`.
- **`core/detection.py` (1,365 LOC)** mixes model loading + geometry/distance math + TTC + interaction finder + drawing. The math (TTC, monotonic checks, distance estimation) is already independently testable and is also used by `tools/analyze.py`. Extract `core/geometry.py`, `core/ttc.py`, `core/interactions.py`; keep `detection.py` for `Detection`/`TrackSample`/`TrackHistory`/`load_model`/`detect_frame`.
- **`services/llm.py` (1,063 LOC)** mixes provider failover, token bucket, circuit breaker, narration, ALPR, chat, settings impact. Split into `llm/{providers.py, throttle.py, narrate.py, enrich.py, chat.py, impact.py}`. Move `_hash_and_strip_plate` to `compliance/privacy.py` (see BE-D7).

**Why it matters.** Any meaningful change crosses responsibilities. `Episode` and `_flush_episode` cannot be unit-tested without booting FastAPI. Review surface for a one-line perception change is implicitly the whole file.

**Options**

| Option | Trade-offs |
|---|---|
| A - Router-only extraction first: one `APIRouter` per feature (`api/live.py`, `api/admin.py`, `api/road.py`, `api/agents.py`, `api/watchdog.py`, `api/retention.py`, `api/llm.py`, `api/tests.py`, `api/streams.py`). `server.py` becomes the composition root. **No behaviour change**, ~2,400 LOC mechanically relocated. | 1-2 weeks. Near-zero risk to perception. Biggest readability win per hour spent. Finishes the pattern the team already started. |
| B - Do A, then extract `Episode` -> `core/episode.py` and `_flush_episode`/`_emit_event` -> `services/event_emission.py` | +1 week. Closes the emission testability gap - emission can be unit-tested without FastAPI. |
| C - Do A + B + the three sibling splits (watchdog, detection, llm) | +1 week. All pure relocations with re-exports. Risk is "wrong import path causes ImportError at boot," caught by `python start.py` + pytest in <30s. |
| D - Full decomposition including `LiveState` / `StreamSlot` into `backend/runtime/` and a `Gate` pipeline for `_on_frame` | 4-6 weeks. Best long-term outcome. Touches shared mutable state and the hot path. Needs the pipeline-gate regression tests pinned first. |
| E - Leave monolith; add `max-lines` lint | Free. Stops growth. Doesn't reduce risk. |

**Recommended: A in Plan A; B + C together in a second Plan A sprint; D only with dedicated Plan B budget.** A is the unlock - every subsequent improvement becomes localized. Commit to D only when C has landed and unit tests exist for each gate; **partial D is worse than no D** because it leaves two half-migrated layouts co-existing.

**Acceptance criteria.**
- After A: `server.py` ≤ 2,000 LOC; no route handler lives outside `backend/api/*.py`.
- After B: `Episode`, `_flush_episode`, `_emit_event` importable without booting FastAPI; at least one unit test per emission branch (privacy scrub, cloud publish enqueue, SSE broadcast).
- After C: `watchdog.py`, `core/detection.py`, `services/llm.py` each ≤ 600 LOC. Sub-module `__init__.py` re-exports preserve every current public name (verified by import smoke test).

**Rollout / rollback.**
- Each extraction ships as its own PR - **no combined PR**. One file moves at a time with re-exports in the old location.
- Pre-flight: `python start.py --skip-tests` + the Sprint 0 smoke scenarios (§8) must pass on the branch before merge.
- Rollback: revert the single PR. Because every extraction is a re-export, rollback is a straight git revert; no schema/state migration.

---

### BE-D3 - Watchdog + queue full-file I/O (BE-3, Medium)

**Observation.**
- [watchdog.py:799-833](backend/services/watchdog.py#L799) `tail()` reads the entire watchdog file then slices the tail. `stats()` at [:917-934](backend/services/watchdog.py#L917) calls `tail(500)`.
- [edge_publisher.py:541-547](backend/integrations/edge_publisher.py#L541) `flush_once()` reads the full queue via `read_text().splitlines()` and rewrites the whole file on success/failure paths ([:580](backend/integrations/edge_publisher.py#L580), [:648](backend/integrations/edge_publisher.py#L648), [:669](backend/integrations/edge_publisher.py#L669)).

**Why it matters.** Both files are append-only and grow unbounded between retention sweeps. At 10k rows each read is the whole history; at 100k, retention and stats become visible in admin latency. This is the classic "works in dev, pages ops at scale" pattern.

**Options**

| Option | Trade-offs |
|---|---|
| A - Reverse-seek incremental tail + windowed writes (truncate+rewrite only every N flushes) | 2-3 days. Keeps file format. Ops tools (`tail -f`, `jq`) still work. Requires careful edge-case handling for partial lines. |
| B - Migrate watchdog findings and outbound queue to SQLite | ~1 week. Cleaner primitives (indexes, atomic delete-where, cursor pagination). Loses line-oriented ops ergonomics. Adds a schema-migration concern. |
| C - Bounded rotation at N MB; keep current read logic | Half day. Caps per-call cost. Breaks queue ordering across rotations if not handled. |

**Recommended: A unless watchdog grows new query patterns.** The moment anyone wants "findings by owner in the last 24h" or "queue rows where retry_count > 5," B becomes the correct answer - SQL pays off when there's more than one access pattern. Today there's one, so A is proportionate.

---

### BE-D4 - HTTP client reuse (BE-4, Medium)

**Observation.** `httpx.AsyncClient()` constructed per-call at [slack.py:403](backend/integrations/slack.py#L403), [slack.py:526](backend/integrations/slack.py#L526), and [edge_publisher.py:612-615](backend/integrations/edge_publisher.py#L612). Each call pays a fresh TCP + TLS handshake.

**Why it matters.** At normal load this is ~10-20 handshakes/min. At burst - which happens exactly during an incident storm when Slack notifications and cloud egress peak together - it amplifies under the conditions where you want fastest egress.

**Options**

| Option | Trade-offs |
|---|---|
| A - Module-level `_client: AsyncClient \| None` lazy singleton, closed in lifespan | 30 min. Standard pattern. Same semantics as the existing LLM client reuse in `services/llm.py`. |
| B - FastAPI `Depends` for request-scoped clients | Cleaner DI for request-scoped calls. Fights the background-task model - edge publisher runs outside request lifecycle. |
| C - Build a shared outbound transport module with pooling + metrics + circuit breaker | Best at fleet scale. Overkill for 2 call sites. |

**Recommended: A.** B is the wrong shape for background tasks; C is premature. A mirrors the pattern already used for Anthropic/Azure clients.

---

### BE-D5 - Inference scheduling under multi-stream (BE-5, Medium)

**Observation.** Four StreamReader threads call `detect_frame(state.model, frame)` against a single model instance ([server.py:1482](backend/server.py#L1482), callbacks at [:1381-1392](backend/server.py#L1381)). At 2 fps * 4 sources = 8 inferences/sec against one GPU slot with ~100ms compute. There's no queue, no priority, no backpressure signal, and no per-stage timing.

**Why it matters.** As source count grows, frames queue invisibly. A slow source silently starves faster ones. There's no observability to know whether you're in that regime.

**Options**

| Option | Trade-offs |
|---|---|
| A - Measurement first: add per-stage timings (YOLO ms, optical flow ms, emit ms) and expose in `/api/admin/health`. No scheduling change. | 1 day. Answers "is this actually a problem?" before we build a solution. |
| B - Single inference worker + bounded `asyncio.Queue`; drop-oldest when behind; expose queue depth | 3-5 days. Explicit backpressure. Frame drops may surprise operators if not surfaced clearly. |
| C - Per-source inference queue + round-robin | More complex. Fairer under source skew. Doesn't fix single-model serialization. |
| D - Multiple model instances (one per device / one per 2 sources) | Highest throughput. Highest memory. Only makes sense on GPU edges with slack. |

**Recommended: A first.** You can't schedule what you can't measure. If A shows real contention in production, B. Skip C and D until the data demands them.

---

### BE-D6 - Typed API contracts (BE-6, Medium)

**Observation.** Zero `response_model=` declarations on any FastAPI route. [server.py:2754-2771](backend/server.py#L2754) `/chat` accepts `body: dict` instead of a validated model. The event dict flows untyped through `_flush_episode` -> `_emit_event` -> SSE -> cloud publish - shape is implicit in docstrings and manual care.

**Why it matters.** The FE re-types everything the BE returns (see FE audit D7). A field rename on BE ships silently to production. Privacy-sensitive fields (`plate_text`) are scrubbed by convention, not by a schema that would fail loudly if a new path re-introduced them.

**Options**

| Option | Trade-offs |
|---|---|
| A - Pydantic models on the 6 highest-traffic routes + a canonical `EventModel`. Generate FE types from `/openapi.json`. | 1 week. Real contract. Privacy invariant becomes enforceable at the schema boundary, not just by code review. Doesn't fight existing patterns. |
| B - `TypedDict` only - IDE inference, no runtime validation | Half the effort. Gives FE-side inference sooner but no runtime guarantee at the boundary. |
| C - Full strict `mypy` rollout on `server.py` (84 untyped returns today) | Months of work. Yields types but not contracts; doesn't help FE. |

**Recommended: A, narrow scope first.** Start with `/api/live/status`, `/api/admin/health`, `/api/live/sources`, `/api/events/{id}`, `/chat`, plus `EventModel`. B is a temporary bridge only if FE needs types faster than A can ship. C is real work but not the leverage point.

**Acceptance criteria.**
- 6 target endpoints declare `response_model=`; `/openapi.json` emits valid schemas for each.
- `EventModel` declared once; `_flush_episode` return type annotated; `_emit_event` typed on input.
- `frontend/src/shared/types/generated.ts` builds from `/openapi.json`; at least one feature (Settings first - see FE D7 & feature rollup) imports the generated type.
- Pydantic schema **enforces** the privacy invariant: `EventModel` has no `plate_text` / `plate_state` fields; any attempt to include them fails at serialization.

**Rollout / rollback (see §9 Contract Migration Plan for full phasing).**
- Phase 1 (BE): add models additively; existing extra fields are still serialized (`model_config.extra = "allow"` during transition).
- Phase 2 (FE): consume generated types alongside the hand-mirrored `common.ts`; both compile.
- Phase 3 (FE): feature-by-feature migration, Settings first (narrowest blast radius).
- Phase 4 (BE): flip `model_config.extra = "forbid"`; remove hand-mirrored slice of `common.ts`.
- Rollback: at any phase, BE flips back to `extra = "allow"` and FE reverts the affected feature's import back to `common.ts`. No lockstep deploy.

---

### BE-D7 - Privacy primitive lives in the wrong package

**Observation.** `_hash_and_strip_plate` is defined in [services/llm.py:732](backend/services/llm.py#L732). The `compliance/` package exists precisely for this class of invariant ([compliance/audit.py](backend/compliance/audit.py), [compliance/retention.py](backend/compliance/retention.py)), but the plate scrub is not there. `_emit_event` also re-pops `plate_text`/`plate_state` as defence in depth at [server.py:2117-2125](backend/server.py#L2117).

**Why it matters.** The privacy invariant ("no raw plate text in any buffer") is the **most important** invariant in the system per [CLAUDE.md](CLAUDE.md). Hiding it inside `services/llm.py` means a future contributor adding a non-LLM enrichment path could miss it. Package names should signal what they enforce.

**Options**

| Option | Trade-offs |
|---|---|
| A - Move `_hash_and_strip_plate` -> `compliance/privacy.py`; re-import from `services/llm.py` | 30 min. Zero behaviour change. Lifts the invariant to the package whose name reflects its purpose. |
| B - Leave and add a bigger docstring + module-header warning | Cheaper. Still hides the invariant from where a reader would expect to find it. |

**Recommended: A.** This is the smallest structural change with the clearest signalling benefit - a reviewer opening `compliance/` sees the privacy primitive where they'd expect it.

---

### BE-D8 - Routes read perception-thread state without the lock

**Observation.** [server.py:2777](backend/server.py#L2777) `live_status()` is a `def` (synchronous, runs on FastAPI's thread pool) and reads `state.reader.frames_read`, `state.reader.frames_processed`, `state.episodes`, `state.recent_events`. The hot-path `_on_frame` mutates these same fields from the perception thread. Same pattern in `admin_health()` ([:3279](backend/server.py#L3279)), `events()` ([:2937](backend/server.py#L2937)), `summary()` ([:3964](backend/server.py#L3964)).

**Why it matters.** Torn reads under load - uptime can briefly see a `None` reader during a slot restart, or inconsistent frame counts. Today it works because the GIL happens to serialize pointer reads; that's an **implementation accident, not a contract**. First bad day in production, this bites.

**Options**

| Option | Trade-offs |
|---|---|
| A - Acquire `state.lock` for every route read that touches a field `_on_frame` writes | Correct but every route now has to document its lock-acquisition contract. Easy to miss on a new route. |
| B - Build a `LiveState.snapshot()` method that takes the lock once and returns a frozen dataclass. Routes consume the snapshot, never the live object. | Medium effort. One canonical path; more reviewable. Aligns with BE-D6 (typed contracts) - the snapshot dataclass is literally the `LiveStatusModel` the FE consumes. |
| C - Leave | Works today. One bad day away from a torn read being the root cause of an on-call ticket. |

**Recommended: B.** Pair it with BE-D6.A: the `LiveStateSnapshot` dataclass and the `LiveStatusModel` Pydantic response are the same object in different directions.

**Acceptance criteria.**
- `LiveState.snapshot()` method exists; returns a frozen dataclass.
- All 4 routes (`live_status`, `admin_health`, `events`, `summary`) consume the snapshot, never the live object.
- Grep for `state.reader.` / `state.quality.` / `state.episodes.` outside `_on_frame`, `snapshot()`, and the lifespan returns 0 matches.
- Under a 1-minute stress run (slot restart during live traffic), no route response contains `None` for uptime / frame counts.

**Rollout / rollback.**
- Ship as a pure additive change: `snapshot()` exists, routes still read directly, no behaviour change. Then flip routes to consume `snapshot()` one at a time, one PR per route.
- Observability: route p95 latency before/after; target regression < 5ms.
- Rollback: revert the per-route flip PR; `snapshot()` stays for the next attempt.

---

### BE-D9 - ByteTrack state is shared across all camera slots

**Observation.** [core/detection.py:1140-1147](backend/core/detection.py#L1140):

```python
results = model.track(frame, persist=True, tracker=TRACKER_CFG, verbose=False)[0]
```

- `persist=True` with **one global** `state.model` means ByteTrack's internal tracker state is shared across every `StreamSlot`. With N cameras at `TARGET_FPS=2`, 2N inferences/s funnel through one call site that maintains one tracker.
- `imgsz`, `half`, `device` are not passed - ultralytics defaults (`imgsz=640`, `half=False`) win even on CUDA hardware that could run half-precision for free.
- No model warmup in `lifespan` - the first real frame after boot pays the JIT/MPS compile cost.
- The RT-DETR validator (66 MB) and MiDaS depth model load lazily on their first use - another cold-path surprise.

**Why it matters.** Cross-camera track-ID collisions are a real multi-source failure mode - a car leaving the front camera's frame and a pedestrian entering the rear camera's frame can inherit each other's IDs because they share a tracker. TTC math derived from bad track history produces wrong risk classifications.

**Options**

| Option | Trade-offs |
|---|---|
| A - Pass explicit `imgsz`/`half=True` (CUDA)/`device=` from config; warm up the model in `lifespan` with one synthetic frame. Pre-load RT-DETR + MiDaS at startup. | 0.5 day. Zero new dependencies. Predictable first-frame latency. Pure win. |
| B - Per-slot tracker state: one `model.track(...)` call site per slot, or separate tracker config files per slot to isolate ByteTrack state | Medium effort. Fixes the cross-camera ID collision. Needs care so memory doesn't balloon with N slots. |
| C - Batch `model.track([f1, f2, ...])` across slots per tick | Biggest throughput win for multi-camera. Doesn't fix the tracker-state sharing unless paired with B. |
| D - Optional ONNX export gated behind `ROAD_YOLO_BACKEND=onnx` for CPU deployments | Deployment-dependent speedup. **Should not be committed without measurement** - no claim of "Xx faster" until benchmarked on target hardware. |

**Recommended: A now (Plan A); B paired with C in Plan B; D only behind a feature flag with measured numbers.** A is a pure win with no design risk. B is the correctness fix for multi-source.

---

### BE-D11 - `/api/live/status` and `/api/admin/health` overlap

**Observation.** [server.py:2777](backend/server.py#L2777) `/api/live/status` returns ~13 fields (source, running, frame counts, uptime, perception flags). [server.py:3279](backend/server.py#L3279) `/api/admin/health` returns nested `server`/`pipeline`/`integrations`/`perception`/`scene`/`ego` - most of the live/status fields again, plus more. FE `useLiveStatus` polls the first every 5s; `useAdminHealth` polls the second every 4s. Settings mounts **both** - see FE audit D2.

**Why it matters.** The FE's single-biggest wasteful-traffic pattern is rooted here. Two overlapping endpoints invite consumers to poll both for completeness.

**Options**

| Option | Trade-offs |
|---|---|
| A - Slow the FE polls on low-value pages (1-line FE change; no BE work) | Immediate relief. Doesn't consolidate the contract. |
| B - Add `/api/live/snapshot` as a single superset endpoint; both FE hooks read it. Old endpoints stay for one release, then deprecate. | 1-2 days BE. Cleanest contract. Needs an endpoint name and a small FE migration. |
| C - Make `/api/admin/health` a strict superset of `/api/live/status`; switch all FE callers | Avoids a new endpoint. Couples the health page's shape to the public live endpoint forever. |
| D - Add `ETag`/`Last-Modified` so polls become conditional 304s | Keeps two endpoints. Cuts wire bytes; doesn't reduce request count or backend CPU. |

**Recommended: A now (FE-owned; see FE D2.A), B in Plan B** once routers move out of `server.py` (BE-D2.A) so the consolidated endpoint has an obvious home. C is a one-way door; avoid. D is a useful add-on to B but not a standalone solution.

**Acceptance criteria.**
- Post-A: Settings page issues ≤1 of the two endpoints per polling interval.
- Post-B: `/api/live/snapshot` exists with `response_model=LiveStatusModel`; FE hooks both read it; old endpoints return `Deprecation` header.

---

### BE-D16 - Bulk source control endpoint

**Observation.** [FE audit D2](frontend-audit-2026-04-20.md#d2---ui-that-calls-the-api-for-non-critical-data) identifies that "Pause all" on N sources fires N POSTs + N GETs. The ceiling for FE-only work is N+1 (per-source POST + one invalidation). Dropping to 2 requests total requires a BE bulk endpoint.

**Why it matters.** The FE acceptance target "≤2 requests on bulk action" is only reachable with a BE endpoint. Without it, the FE matrix ships an unattainable goal. Also: per-source POST storms during an incident (operator mashing "Pause all" while investigating) amplify load exactly when it hurts.

**Options**

| Option | Trade-offs |
|---|---|
| A - Add `POST /api/live/sources/bulk` accepting `{ids: string[], action: "start"\|"pause"\|"setDetection", enabled?: bool}`. Applies per-slot atomically; returns an array of per-slot results | 1 day. Matches existing slot control semantics. Partial-failure semantics are explicit (per-slot result). |
| B - Add `POST /api/live/sources/{action}` with `{ids: [...]}` body (action in the URL) | 1 day. Slightly easier to extend with new actions. Less REST-orthodox. |
| C - Skip; accept the N+1 ceiling on FE | 0 effort. FE stays at ~7 requests for a 6-source bulk action instead of 2. Acceptable if bulk actions are rare. |

**Recommended: A** if bulk actions are part of normal operator flow; **C** if they're rare (once-a-day). The decision depends on operator usage patterns the audit can't see. Flag to the team as a product question, not just an engineering one.

**Prerequisites.** Must ship with auth from [BE-D12](#be-d12---control-endpoints-unauthenticated-be-12-critical) — a public bulk endpoint is worse than N public endpoints (same trust boundary, larger DoS surface per request).

**Acceptance criteria.**
- `POST /api/live/sources/bulk` with 6 ids + `action: "pause"` returns 200 with 6 per-slot results.
- Auth required (401 without token).
- FE "Pause all" on 6 sources fires ≤2 network requests end-to-end.

**Rollout / rollback.** Feature flag `ROAD_BULK_SOURCE_CONTROL=1`. Rollback: FE falls back to per-source POSTs (D2.D ceiling) automatically if the bulk endpoint returns 404 — add this fallback to the FE adapter.

---

### BE-D12 - Control endpoints unauthenticated (BE-12, **Critical**)

**Observation.** Multiple endpoints that **mutate system state or operator configuration** carry explicit `AUTH: public` docstrings:
- [server.py:3373](backend/server.py#L3373) `POST /api/validator/toggle` - "public (read-only toggle of a background observability job; does not affect live alerts)" - but it *does* mutate the validator worker's accept state.
- [server.py:3680](backend/server.py#L3680) `POST /api/live/sources/{id}/start` - "public (operator network)".
- [server.py:3801](backend/server.py#L3801) `POST /api/live/sources` - registers a new perception source from a user-pasted URL (also see BE-D15 for SSRF).
- [server.py:3947](backend/server.py#L3947) `POST /api/tests/run` - triggers a full pytest run (CPU-heavy; easy to script-abuse).
- Implied: the whole `/api/live/sources/{id}/{start,pause,stop,detection}` family.

**Why it matters.** "Network-gated operator UI" is a **deployment assumption**, not a property of the code. Any misconfigured reverse proxy, VPN split-tunnel, LAN-exposed edge host, or curl-from-inside-the-office scenario turns these into unauthenticated remote control. The project already has `require_bearer_token()` in [backend/security.py](backend/security.py) used by `/api/audit`, `/api/llm/*`, `/api/road/*`, `/api/agents/*`, `/api/retention/*` - the infrastructure is in place; these endpoints just don't use it.

**Options**

| Option | Trade-offs |
|---|---|
| A - Apply `Depends(require_bearer_token)` to every mutating endpoint. FE already sends `Authorization: Bearer` via [adminApi.ts](frontend/src/shared/lib/adminApi.ts); the auth flow exists end-to-end. | 1 day. Matches the existing admin-tier pattern. Breaking change only for unauthenticated callers (which should not exist). |
| B - Introduce a separate "operator" tier token distinct from "admin" (e.g. `X-Operator-Token`) so read-only operators can start/pause streams without full admin rights | 2-3 days. More principled RBAC. Needs token provisioning story. |
| C - Rely on network segmentation (reverse proxy ACL or VPN) | 0 code change. Externalizes the entire trust boundary. Acceptable only if deployment procedures guarantee it, and the guarantee is tested in CI/ops. |
| D - Leave | Ships a system that requires a specific deployment shape to be safe, without code-level enforcement. |

**Recommended: A immediately (pre-production blocker).** B is the right long-term design once operator/admin roles diverge; today both surfaces are used by the same operator UI, so the extra token tier isn't earning its keep. C alone is insufficient; it can layer on top of A but not replace it.

**Acceptance criteria.**
- Every endpoint whose docstring says `AUTH: public` but which mutates state declares `Depends(require_bearer_token)` or an equivalent decorator.
- A static check (or test) enumerates FastAPI routes and fails CI if a non-`GET` route has no auth dependency and is not in a whitelist (e.g. `/api/feedback`, `/healthz`).
- Integration test: an unauthenticated `POST /api/live/sources` returns 401/403, never 200.

**Rollout / rollback — with hard cutover.**
- **Release N:** Ship behind `ROAD_REQUIRE_AUTH` env flag, **default-OFF**. Ops has exactly one release window (2 weeks) to set `ROAD_ADMIN_TOKEN` in every deployment.
- **Release N+1: default flips to ON.** Deployments without a token fail closed at boot. This is a **hard deadline, not a soft target** — security work must not accrete as permanent opt-in.
- **Release N+2: flag removed entirely.** `require_bearer_token()` becomes unconditional; the env var is ignored.
- Observability: log `auth_failure_by_route` counter during release N so ops can spot untokenized deployments before the flip.
- Rollback during release N only: flip flag off, investigate which deployment path was missing the token, fix it before the N+1 flip. **Release N+1 is not rollback-eligible** — if a deployment breaks at the flip, the correct action is to fix the deployment, not relax the auth.

---

### BE-D13 - Live media/detection streams unauthenticated (BE-13, **Critical**)

**Observation.** [server.py:3592](backend/server.py#L3592) `GET /admin/video_feed` and [:3606](backend/server.py#L3606) `/admin/video_feed/{source_id}` return **MJPEG live camera streams** with `AUTH: public (network-gated operator UI)`. [:3619](backend/server.py#L3619) `GET /admin/frame/{source_id}` returns a single-shot JPEG. [:3899](backend/server.py#L3899) `GET /admin/detections` is an SSE stream of per-frame bounding boxes.

**Why it matters.** These are the **live camera feeds**. If the perimeter is weak, anyone on the network observes the annotated video stream of every source the edge is processing. The detection SSE also leaks object positions / track IDs, which is useful reconnaissance on its own. Unlike the public safety-event SSE (`/stream/events`), these endpoints expose **continuous frame-level** data with no redaction.

Paired failure: [server.py:818-874](backend/server.py#L818) already has thumbnail-token signing infrastructure (HMAC-signed timed URLs for public thumbnails). That primitive is the right fit for per-tile live feeds too, but is currently only used for safety-event thumbnails.

**Options**

| Option | Trade-offs |
|---|---|
| A - Require `Authorization: Bearer` via `require_bearer_token()`, same as BE-D12 | 1h. Consistent with admin pattern. FE already sends the header for other admin calls; MJPEG is the one surface that doesn't because `<img src>` and `EventSource` can't send headers. **Needs short-lived signed URLs (see B) as the delivery mechanism.** |
| B - Emit short-lived HMAC-signed URLs (same primitive as public thumbnails) and require the signature at the endpoint. FE mints the URL via an authenticated JSON call, then uses it in `<img>`/`EventSource`. | 1 day. Clean solution for header-less browser APIs. Signature bound to source_id + expiry. Rotation on token change invalidates all outstanding URLs within TTL. |
| C - Proxy MJPEG through an authenticated WebSocket or Server-Sent-Events wrapper on the FE | Medium. More moving parts. Not well-matched to the MJPEG browser primitive. |
| D - Leave (network-gate in production) | External dependency on deployment shape. Same risk as BE-D12.C. |

**Recommended: B.** Short-lived signed URLs are the idiomatic fix for auth on `<img>` and `EventSource`; the thumbnail-token infrastructure in `server.py:818-874` already demonstrates the pattern. **Pair with BE-D12.A** so the mint-URL endpoint itself is auth-gated.

**Acceptance criteria.**
- `/admin/video_feed*`, `/admin/frame/*`, `/admin/detections` reject requests without a valid signature (or bearer, whichever the final design chooses).
- Signature TTL ≤ 5 minutes; FE auto-refreshes via the StreamImage / EventStream hook.
- Log counter `media_auth_failure` wired.

**Rollout / rollback — with hard cutover.**
- **Release N:** Ship signed-URL mint endpoint + signature validation. Unsigned path (`/admin/video_feed*`, `/admin/frame/*`, `/admin/detections`) continues working alongside for **exactly one release** so FE can migrate.
- **Release N+1:** Unsigned path returns 401. Signed path is the only way in. FE has been on signed URLs since Release N deployed.
- **Release N+2:** Unsigned code paths removed from `server.py`.
- **Hard deadline:** coexistence window is two weeks. Document the sunset date in the commit that ships Release N. No extensions without a written risk acceptance.
- FE tracking item: [FE-DSec](frontend-audit-2026-04-20.md#dsec---cross-doc-dependency-on-be-auth-boundary) must land within the coexistence window.

---

### BE-D14 - Clip endpoint is a public DoS vector (BE-14, High)

**Observation.** [server.py:2974](backend/server.py#L2974) `GET /api/events/{event_id}/clip?before=3&after=3&annotated=1` is `AUTH: public`. On cache miss with `annotated=1`, [:3043](backend/server.py#L3043) calls `_render_annotated_event_clip()`, which runs a **full YOLO inference pass** over every frame in the ±N-second window before writing the MP4 to disk.

Parameters are loosely bounded: `before` and `after` are clamped to `[0, 30]` (line 3030), so a single request can render up to **60 seconds of YOLO-annotated video**. Cache key is `{event_id}_{before}_{after}_annotated.mp4` - so an attacker can vary `before=2.5` vs `before=2.6` vs `before=2.7` and **force cache misses indefinitely** against the same event, each one a full YOLO pass + ffmpeg encode.

**Why it matters.** The system has a foot-gun pattern: public + unbounded-fanout cache key + expensive compute. A scripted attacker can pin the GPU at 100% and fill `data/clips/` with orthogonal cache entries until disk exhausts, which takes the whole edge node offline. Unlike BE-D12/D13 this is not purely a trust-boundary issue; even behind auth it would need rate-limiting.

**Options**

| Option | Trade-offs |
|---|---|
| A - Require auth (see BE-D12) + quantize `before`/`after` to a small set of allowed values (e.g. `{1, 3, 5, 10}`) so the cache key space is bounded | 0.5 day. Kills the cache-miss amplification. Loses fine-grained clip windowing (was anyone using it?). |
| B - Add a per-IP / per-token rate limit on `/api/events/*/clip` (e.g. 3 cache-miss renders per minute) | 1 day. Preserves flexibility. Needs a rate-limiter (new dep or hand-rolled token bucket - the LLM layer already has one). |
| C - Pre-render clips on emit. `_emit_event` schedules a background render of the ±5s clip into cache; the endpoint only serves cached files and 404s on miss. | 2-3 days. Predictable resource profile. Wastes compute on events no one reviews. |
| D - Feature-flag annotated clips off in production | 5 min. Loses the feature. |

**Recommended: A + B together.** A bounds the cache key space; B caps work per caller. C is elegant but wastes compute on 95% of events. **Gate behind BE-D12 auth as a prerequisite** - even rate-limited, this endpoint should not be public.

**Acceptance criteria.**
- `before`/`after` accept only a whitelisted enum.
- Token-bucket limit: 3 cache-miss annotated renders per minute per bearer token; unlimited on cache hit.
- Integration test: a loop hammering different `before` values is throttled after N requests.

**Rollout / rollback.** Feature flag `ROAD_CLIP_RATE_LIMIT=1`; rollback is flag-off.

---

### BE-D15 - SSRF-style risk on `/api/live/sources` (BE-15, High)

**Observation.** [server.py:3801-3827](backend/server.py#L3801) accepts a JSON body with a user-controlled `url` field. Validation is one prefix check at [:3827](backend/server.py#L3827): `if not (url.startswith("http://") or url.startswith("https://")): raise 400`. No host allowlist. No blocklist for RFC1918 / loopback / link-local. No check against the cloud-metadata service address (`169.254.169.254`).

That URL is then passed through [:1313](backend/server.py#L1313) into the stream reader. For `youtube.com` inputs, [stream.py:154](backend/core/stream.py#L154) `resolve_hls()` invokes **`yt-dlp`** as a subprocess to resolve the URL. For other inputs, OpenCV / ffmpeg opens the URL directly.

**Why it matters.** Two classes of abuse on top of the BE-D12 control-boundary issue:
1. **SSRF.** An attacker pastes `http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS cloud metadata) or `http://127.0.0.1:8500/v1/kv/` (local Consul, etc.). The edge host fetches it. Depending on the error path, response bodies may leak through slot status fields or logs.
2. **Subprocess exposure.** `yt-dlp` is a large attack surface that processes attacker-supplied URLs. Historical `yt-dlp` CVEs exist around URL parsing and extractor logic.

**Options**

| Option | Trade-offs |
|---|---|
| A - Auth first (BE-D12), then add a URL validator: reject RFC1918 / loopback / link-local / cloud-metadata IPs; restrict hostnames to a configured allowlist or explicit non-private resolution via `socket.getaddrinfo` with rejection of private addresses | 1 day. Standard SSRF mitigation. Needs DNS re-resolution check to defeat DNS-rebinding. |
| B - Auth + the validator in A + run `yt-dlp` in a sandbox (bubblewrap / container) with no network access beyond the resolved URL's host | 2-3 days. Defense in depth for the subprocess path. |
| C - Remove the "paste a URL" feature entirely; only allow sources from a pre-configured list in env | 1h. Kills the feature. Appropriate if live-add is rarely used. |
| D - Auth only (rely on it to prevent abuse) | Doesn't mitigate a compromised admin credential or an insider. |

**Recommended: A + C-as-a-kill-switch.** A is the mitigating control. C is the emergency brake: if live-add is used <1×/week, the tradeoff favours removal. B is the right long-term answer if the feature is used often.

**Acceptance criteria.**
- URL resolution rejects all of: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1/128`, `fc00::/7`, `fe80::/10`.
- DNS resolution happens once and the resolved IP is the one actually dialled (no DNS rebinding).
- `yt-dlp` invocation is timeout-bounded (≤30s) with a small memory budget.
- Integration test: POST `http://169.254.169.254/` returns 400, not 500, not 200.

**Rollout / rollback.** Bundle with BE-D12's `ROAD_REQUIRE_AUTH=1` flag; rollback is flag-off. Option C is a separate feature flag `ROAD_ALLOW_DYNAMIC_SOURCES=0`.

---

### BE-D10 - `config.py` has no schema

**Observation.** [backend/config.py](backend/config.py) is 598 LOC of `os.getenv("ROAD_X", default)` calls - roughly 70 env vars read at import time. No validation. A typo in `ROAD_TARGET_FPS` silently keeps the default. `ROAD_TARGET_FBS=4` boots happily with the wrong value.

**Why it matters.** Production misconfigurations are the silent kind. The edge fleet deploys via env vars; a typo in a deploy script is a failure mode that won't surface until someone notices the wrong behaviour in the field.

**Options**

| Option | Trade-offs |
|---|---|
| A - Replace with `pydantic-settings.BaseSettings` - typed fields, validation at import, fail loud on bad types or unknown keys | 1 day. Adds one dependency. Removes a class of silent prod bugs. Self-documenting. |
| B - Hand-rolled validation function called from `lifespan` | Half the work; partial coverage. No help for "unknown key" typos. |
| C - Leave | Today's behaviour. Accepts the silent-bug class. |

**Recommended: A in Plan B.** Deferred to Plan B because it's independent of the correctness and decomposition work; the value is long-term reliability rather than short-term unblocking.

---

## 7. Sequencing

Ordered by **correctness -> observability -> testability -> scale**, not by module.

**Completed baseline block (already landed):**
Sprint 0 security and verification work + Plan A core items (BE-D12/13/14/15, BE-D2.A/B, BE-D6 Ph1, BE-D7, BE-D8, BE-D4, BE-D5.A, BE-D1.B) are now in-tree (§1.1).

**Next 1-2 sprints (highest leverage remaining):**
1. **BE-D3** — replace full-file watchdog/queue reads with incremental/tail-aware I/O.
2. **BE-D11** — reduce overlapping poll surfaces (`/api/live/status` vs `/api/admin/health`) and remove duplicate FE poll pressure.
3. **BE-D10** — adopt typed config schema (`pydantic-settings`) with fail-fast validation in non-dev environments.

**Evidence-gated scale phase (only after metrics justify it):**
4. **BE-D9.B/C** — per-slot tracker/scheduling changes only if timing/quality evidence shows real multi-source contention.
5. **BE-D2.C** — deeper sub-splits (watchdog/detection/llm internals) only when maintainability ROI is clear.
6. **BE-D1.C + BE-D6 Phase 4** — remove legacy compatibility paths only after FE migration is fully complete.

**What this sequencing demonstrates:**

1. **Correctness before architecture.** BE-D1 (wrong source on events), BE-D8 (torn reads), BE-D9.A (warmup) all ship before any module moves.
2. **Finish what was started.** BE-D2.A follows the extraction pattern already present in `api/settings.py` and `api/feedback.py`. It's not a new strategy - it's completing one.
3. **Measurement before optimization.** BE-D5.A ships before BE-D5.B is scheduled; BE-D9.D is explicitly gated on benchmarks.
4. **Pair structural changes with contracts.** BE-D8's snapshot dataclass and BE-D6's response model are the same object - do them together.
5. **Package names should signal what they enforce.** BE-D7 moves the privacy primitive into `compliance/` so the invariant lives where a reviewer would look for it.

**What to resist:**

- Jumping to BE-D5.B/C/D before metrics (BE-D5.A) exist.
- Partial BE-D2.D that stops halfway - two co-existing module layouts is worse than one consistent monolith.
- Migrating watchdog/queue to SQLite (BE-D3.B) before there's a second access pattern to justify the schema cost.
- Committing BE-D9.D (ONNX) without benchmarks on target edge hardware.
- Calling the FE/BE typing work "shared" - it lives in BE (source of truth). FE should consume, not re-type.

## 8. Sprint 0 — Verification Prerequisites

Sprint 0 prerequisites are now considered **satisfied** in the active workspace.

Current baseline:

1. **Backend tests runnable:** `pytest` executes successfully in `.venv`.
2. **Grouped test targets available:** `make test-be`, `make test-fe`, `make test-all`.
3. **Typecheck target available and green:** `make typecheck` (`pyright`) passes.

Recommended ongoing merge bar (carry forward):

- `make test-all` green.
- `make typecheck` green.
- `make lint` green.
- Critical runtime smoke (`python start.py --skip-tests --no-browser` + `/api/live/status` 200) on refactor-heavy PRs.

## 9. Contract Migration Plan (shared with FE-D7)

Cross-doc execution plan for BE-D6 ↔ FE-D7. The FE audit references this section rather than duplicating it.

| Phase | Owner | What ships | FE impact | Duration |
|---|---|---|---|---|
| **1** | BE | Add `response_model=` + `EventModel` on the 6 target endpoints (`/api/live/status`, `/api/admin/health`, `/api/live/sources`, `/api/events/{id}`, `/chat`, `EventModel` itself). `model_config.extra = "allow"` during transition. | None - responses identical. | 1 week |
| **2** | FE | Add `frontend/src/shared/types/generated.ts` emitted from `/openapi.json` (Vite plugin or build step). Both `generated.ts` and `common.ts` compile. | No runtime change. | 2 days |
| **3** | FE | Migrate feature-by-feature to generated types. **Order: Settings → Validation → Admin → Dashboard.** Smallest blast-radius first. | Incremental; each feature is one PR. | 1-2 weeks |
| **4** | BE | Flip `model_config.extra = "forbid"` after FE audit confirms no feature still reads legacy extra fields. Remove overlapping hand-mirrored slice of `common.ts` from FE. | Strict contract enforced. | 2 days |

**Backward-compat window:** each phase waits **one full release (2 weeks)** before the next. No lockstep deploys are required at any phase.

**Bridge if BE slips > 1 quarter:** FE-D7.B activates — FE adds `zod` schemas at the fetch layer for the 6 endpoints, catches drift on the FE side independent of BE rollout. Bridge is scoped to the exact 6 endpoints; no broader zod adoption.

**Rollback:**
- At any phase, BE can revert to `extra = "allow"` (Phase 4 → 3 rollback is a single config flip).
- FE can revert the affected feature's import back to `common.ts` (per-feature, per-PR).
- Neither side forces the other to revert - the plan is decoupled by construction.

## 10. Execution Matrix

One row per actionable decision. **Owner** = BE or FE. **Depends-on** = prerequisite decisions. **Accept** = pointer to the decision's acceptance criteria.

### Current status overlay

| ID | Current status |
|---|---|
| S0 | Done |
| BE-D12 | Done |
| BE-D13 | Done |
| BE-D14 | Done |
| BE-D15 | Done |
| BE-D2.A/B | Done |
| BE-D6 Phase 1 | Done |
| BE-D7 | Done |
| BE-D8 | Done |
| BE-D4 | Done |
| BE-D5.A | Done |
| BE-D16 | Partial |
| BE-D11 | Open |
| BE-D3 | Open |
| BE-D10 | Open |
| BE-D9.B/C | Open (evidence-gated) |
| BE-D1.C + BE-D6 Phase 4 | Open (FE-gated) |

| ID | Decision | Owner | Effort | Depends-on | Accept | Sprint |
|---|---|---|---|---|---|---|
| S0 | Sprint 0: test tooling + smoke script | BE | 3 days | - | §8 exit | 0 |
| **BE-D12** | **Auth on mutating endpoints** | **BE** | **1 day** | **S0** | **§BE-D12** | **0** |
| **BE-D15** | **SSRF validator on `/api/live/sources`** | **BE** | **1 day** | **BE-D12** | **§BE-D15** | **0** |
| **BE-D14** | **Clip endpoint auth + rate limit + quantized params** | **BE** | **1 day** | **BE-D12** | **§BE-D14** | **0** |
| **BE-D13** | **Signed URLs for media/detection streams** | **BE** | **1-2 days** | **BE-D12** | **§BE-D13** | **0** |
| BE-D16 | Bulk source control endpoint (only if bulk actions are common) | BE | 1 day | BE-D12 | §BE-D16 | 1 |
| BE-D1 | Primary-slot leakage | BE | 1 week | S0 | §BE-D1 | 1 |
| BE-D7 | Privacy primitive → `compliance/` | BE | 30 min | S0 | §BE-D7 | 1 |
| BE-D8 | `LiveState.snapshot()` + route migration | BE | 3 days | S0 | §BE-D8 | 1 |
| BE-D4 | HTTP client reuse | BE | 30 min | S0 | §BE-D4 | 1 |
| BE-D9.A | Inference knobs + warmup + preload | BE | 0.5 day | S0 | §BE-D9 | 1 |
| BE-D5.A | Stage timings in admin health | BE | 1 day | S0 | §BE-D5 | 1 |
| BE-D11.A | Slow overlapping FE polls | FE | 1 h | - | §BE-D11 | 1 |
| BE-D2.A | Router-only extraction (51 routes) | BE | 1-2 weeks | S0 | §BE-D2 | 2 |
| BE-D2.B | Extract `Episode` + emission | BE | 1 week | BE-D2.A | §BE-D2 | 2 |
| BE-D6.A Ph1 | `response_model=` on 6 endpoints | BE | 1 week | BE-D2.A, BE-D8 | §BE-D6 | 2 |
| Gates tests | Unit tests for Quality/Ego/Scene/Convergence | BE | 4-6 h | BE-D2.B | existing | 2 |
| BE-D2.C | Sub-splits (watchdog/detection/llm) | BE | 1 week | BE-D2.B | §BE-D2 | 3+ |
| BE-D6 Ph4 | `extra=forbid` + remove FE mirror | BE | 2 days | FE Ph3 | §BE-D6 | 3+ |
| BE-D9.B+C | Per-slot tracker + batched inference | BE | 1 week | BE-D5.A evidence | §BE-D9 | 3+ |
| BE-D10 | `pydantic-settings` | BE | 1 day | BE-D2.A | §BE-D10 | 3+ |
| BE-D3 | Watchdog/queue I/O | BE | 2-3 days (A) / 1 week (B) | file-growth evidence | §BE-D3 | 3+ |
| BE-D1.C | Remove primary-proxy aliases | BE | 1 day | FE migration done | §BE-D1 | 4+ |

**Reading the matrix.**
- Sprint 1 is the correctness + quick-wins block (all of BE-D1, BE-D7, BE-D8, BE-D4, BE-D9.A, BE-D5.A fit together because each is ≤1 week and they don't conflict).
- Sprint 2 is the structural sprint (BE-D2.A → B → BE-D6 Ph1, in strict order).
- Sprint 3+ items are evidence-gated or FE-gated; do not commit to dates on them.
