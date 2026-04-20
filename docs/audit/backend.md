# Backend audit — `backend/`

**Scope:** Python / FastAPI / perception pipeline under `backend/` plus `cloud/`.
**Method:** Read every module top-to-bottom, counted lines, traced the hot path through `_on_frame`, and inspected every route registration in `server.py`. Findings cite the exact path + line range so the reasoning is auditable.

Each finding follows the same template:

> **Observed** → file path + line range + the pattern actually present.
> **Why it matters** → concrete impact.
> **Options** → 2–4 ways to address.
> **Trade-offs** → what each option costs / gives up.
> **Recommendation** → the option I would pick *for this codebase's stage*, with reason.

Strengths to call out first (so this reads as analytical, not a complaint sheet):

- The package layout under `backend/` already separates concerns at the top level — `core/` (perception), `services/` (LLM, redact, drift, watchdog, registry), `compliance/` (audit, retention), `integrations/` (slack, edge_publisher), `api/` (settings, feedback). The skeleton is right; the issue is that `server.py` never finished migrating into it.
- Privacy is treated as a real invariant, not an afterthought — `_hash_and_strip_plate` is enforced at ingest in `services/llm.py::enrich_event` and `_emit_event` re-pops `plate_text` / `plate_state` as defence in depth ([backend/server.py:2117-2125](../../backend/server.py)).
- LLM layer already implements multi-provider failover, token-bucket rate budget, circuit breaker, and self-consistency ALPR — these are real production patterns, not toys.
- `tests/` actually exercises the pipeline (`tests/test_core.py` covers the gates).
- `compliance/retention.py` runs hourly retention sweeps; `compliance/audit.py` logs sensitive accesses. Compliance posture is mature for the project's stage.

---

## 1. Type safety

### 1.1 No type checker in the toolchain

**Observed.** [pyproject.toml](../../pyproject.toml) declares only `pytest` (+ pytest plugins) under `[project.optional-dependencies].dev`. `make lint` is `py_compile` on three files (`server.py`, `config.py`, `start.py`) per [CLAUDE.md](../../CLAUDE.md). No `mypy`, `pyright`, or `ruff` configured. No CI type check.

**Why it matters.** The 22,000-line backend has rich domain types (`Detection`, `Episode`, `StreamSlot`, `LiveState`, `CameraCalibration`) but the *flow between them* is unchecked. The `event` dict is the central currency of the system and its shape is asserted nowhere.

**Options.**
- **(a)** `mypy --strict` on a small allow-list — `backend/api/`, `backend/services/llm.py`, `backend/services/redact.py`. Grow over time.
- **(b)** `pyright` workspace-wide in `basic` mode — broader coverage, more findings up front.
- **(c)** Skip until the refactor settles.

**Trade-offs.**
- (a) catches issues at the API boundary first — the boundary that crosses the wire to the FE. Incremental, easy to land. Misses internal-function bugs.
- (b) covers more ground but tends to produce a noisy initial backlog of `Optional` / `Any` warnings that chase contributors away from the tool.
- (c) lets the same drift bugs keep shipping — every dict-shape change is a silent FE break.

**Recommendation.** **(a).** Per the project's user rule, run only after explicit approval. Pair with item 1.2 below.

### 1.2 The central domain object is `dict`

**Observed.** Searched signatures across `backend/`:

- `_emit_event(event: dict, internal_thumb_name: str)` ([server.py:2053](../../backend/server.py))
- `narrate_event(event: dict)` ([services/llm.py:498](../../backend/services/llm.py))
- `enrich_event(event: dict, thumb_path: Path)` ([services/llm.py:788](../../backend/services/llm.py))
- `slack_notify(event: dict, ...)`, `edge_publisher.enqueue(event, ...)` — all take `dict`.
- The FE mirror is hand-written at [frontend/src/shared/types/common.ts](../../frontend/src/shared/types/common.ts) (340 lines).

**Why it matters.** Adding a field — or *renaming* one — passes every test that doesn't happen to assert that exact key. The FE breaks silently because nothing ties the two sides together.

**Options.**
- **(a)** `pydantic.BaseModel` for the top 5 most-traversed payloads (`SafetyEvent`, `LiveStatus`, `HealthData`, `LiveSourceStatus`, `DetectionSnapshot`). Generate `frontend/src/shared/types/generated.ts` with `fastapi-pydantic-to-typescript` or `datamodel-code-generator`.
- **(b)** Full OpenAPI codegen — every FastAPI handler declares `response_model=`, the FE consumes a generated client (`openapi-typescript-codegen` / `orval`).
- **(c)** Frozen `@dataclass(slots=True)` instead of pydantic — type-checked but no runtime validation, no JSON schema.

**Trade-offs.**
- (a) targets the highest-traffic types first; one PR, ~5 model files; keeps `fetchClient` and `adminApi` plumbing untouched.
- (b) eliminates drift permanently but every one of the 53 routes needs a `response_model=` and the build needs an OpenAPI emit step. Bigger blast radius.
- (c) zero new deps but doesn't solve the FE side and gives up free request validation on `/chat` etc.

**Recommendation.** **(a)** in Plan A; **(b)** in Plan B once handler decomposition (item 2.1) makes adding `response_model=` a one-liner per file.

---

## 2. Modularity & layout

### 2.1 `server.py` is a 4,000-line god module

**Observed.** [backend/server.py](../../backend/server.py) is **3,972 lines**. It contains:

| Concern | Location |
| --- | --- |
| 53 HTTP routes | scattered between line 2604 and 3964 |
| `Episode` class | line 288 |
| `StreamSlot` class | line 454 |
| `LiveState` singleton | line 625 |
| Thumbnail token signing | lines 818–874 |
| Score-decay loop | line 877 |
| Frame-render helpers | lines 1008–1297 |
| Slot lifecycle (`_start_slot`, `_pause_slot`, `_resume_slot`, `_stop_slot`) | lines 1299–1380 |
| **Hot-path `_on_frame`** | lines 1396–1832 (~430 LOC) |
| `_flush_episode` | line 1833 |
| `_broadcast_perception` / `_broadcast_admin_detections` | lines 2006–2050 |
| `_emit_event` | lines 2053–2167 |
| `lifespan` (startup/shutdown) | lines 2183–2477 |
| MJPEG plumbing | lines 3494–3665 |

**Why it matters.** Every change requires reading 4,000 lines of context. Test setup is monolithic — you cannot import a route without booting the perception state. Code review becomes "trust me" because the diff is hard to localize.

**Options.**
- **(a)** Extract routers only — one `APIRouter` per feature: `api/live.py`, `api/admin.py`, `api/road.py`, `api/agents.py`, `api/watchdog.py`, `api/retention.py`, `api/llm.py`, `api/tests.py`, `api/streams.py`. Keep `server.py` as the composition root that mounts them. **No behaviour change.**
- **(b)** Also move `LiveState` / `StreamSlot` / `Episode` into `backend/runtime/`.
- **(c)** Full pipeline split (see item 5.1 below) — extract `_on_frame` into a `Pipeline` of `Gate` objects.
- **(d)** Leave as-is; the file works.

**Trade-offs.**
- (a) is mechanical, near-zero risk to perception, ~2,400 lines mechanically relocated. Biggest readability win per hour spent.
- (b) starts touching shared mutable state — `_on_frame` reads/writes `state.X` constantly. Needs care with the `state.lock` semantics.
- (c) is a multi-week refactor with real test debt to pay first; `_on_frame` has 16 numbered gates with comments warning "do not short-circuit".
- (d) keeps every change "scary".

**Recommendation.** **(a)** in Plan A; **(b)** then **(c)** in Plan B.

### 2.2 Split between `server.py` and `backend/api/` is inconsistent

**Observed.** Two of the 53 routes have already been extracted into [backend/api/settings.py](../../backend/api/settings.py) (669 lines) and [backend/api/feedback.py](../../backend/api/feedback.py) (308 lines). The other 51 routes live inline in `server.py`. There is a `backend/api/__init__.py` but no per-feature router file.

**Why it matters.** New contributors don't know where to add a route. The pattern "extract when convenient" produces an arbitrary split.

**Options.** Same as 2.1 (a) — finish the extraction the team already started.

**Recommendation.** Treat 2.1 (a) as also closing this gap.

### 2.3 Privacy logic lives in the wrong package

**Observed.** `_hash_and_strip_plate` is in [services/llm.py:732](../../backend/services/llm.py). The `compliance/` package exists for exactly this kind of invariant ([compliance/audit.py](../../backend/compliance/audit.py), [compliance/retention.py](../../backend/compliance/retention.py)) but the plate scrub is not there.

**Why it matters.** The privacy invariant is the *most important* invariant in the system per [CLAUDE.md](../../CLAUDE.md). Hiding it inside `services/llm.py` means a future contributor wiring a non-LLM enrichment provider could miss it.

**Options.**
- **(a)** Move `_hash_and_strip_plate` to `compliance/privacy.py`, re-import from `services/llm.py`.
- **(b)** Leave it but document it more loudly.

**Recommendation.** **(a).** S effort, zero behaviour change, lifts the invariant to the package whose name reflects its purpose.

---

## 3. Massive files (LOC ranking)

```
3972  backend/server.py
1804  backend/services/watchdog.py
1365  backend/core/detection.py
1063  backend/services/llm.py
1009  backend/services/drift.py
 885  backend/services/agents.py
 785  backend/core/validator.py
 722  backend/integrations/edge_publisher.py
 675  backend/integrations/slack.py
 669  backend/api/settings.py
 663  backend/core/stream.py
 650  backend/core/egomotion.py
 641  backend/services/settings_db.py
 599  backend/services/impact.py
 598  backend/config.py
 570  backend/core/orientation_policy.py
 543  backend/services/test_runner.py
 517  cloud/receiver.py
```

**Top 4 are the actionable ones.** `server.py` is covered in 2.1. The other three:

- **`services/watchdog.py` (1,804 lines)** mixes rule checks, AI analyzer, storage, grouping, and the `Watchdog` orchestrator. Function map: `_slugify` / `_severity_rank` / `_priority_score` / `_evidence` / `_top_bucket` / `_parse_ts` / `_fingerprint_for` / `_defaults_for` / `_normalize_finding_payload` / `_normalize_finding` / `_group_findings` / `WatchdogFinding` (class) / `_write_finding` / `tail` / `delete_findings` / `delete_findings_by_id` / `stats` / `_make_finding` / `_rule_checks` (lines 1039–1556 — ~500 LOC by itself) / `_ai_analyze` / `Watchdog` (class).
  - **Recommendation**: split into `watchdog/{rules.py, ai.py, storage.py, fingerprint.py, orchestrator.py}`. Same package name, sub-modules; no API change.

- **`core/detection.py` (1,365 lines)** mixes model loading, geometry/distance math, TTC, interaction finder, drawing, summary builder. The math (TTC, monotonic checks, distance estimation) is independently testable and used by `tools/analyze.py` too.
  - **Recommendation**: extract `core/geometry.py` (distance + bbox math), `core/ttc.py` (`_is_monotonic_*`, `estimate_ttc_sec`, `estimate_pair_ttc`, `tracks_converging`, `classify_risk`), `core/interactions.py` (`find_interactions`), and keep `detection.py` for `Detection`/`TrackSample`/`TrackHistory`/`load_model`/`detect_frame`.

- **`services/llm.py` (1,063 lines)** mixes provider failover, token bucket, circuit breaker, narration, ALPR, chat, settings impact analysis.
  - **Recommendation**: extract `llm/{providers.py, throttle.py, narrate.py, enrich.py, chat.py, impact.py}`. Privacy primitive (`_hash_and_strip_plate`) goes to `compliance/privacy.py` per item 2.3.

**Trade-off note.** All three splits are pure module relocations with re-exports. No behaviour change. Risk is "wrong import path causes ImportError at boot" — caught by `python start.py` and `pytest` in <30 s.

---

## 4. Network performance / wasteful traffic

### 4.1 `/api/live/status` and `/api/admin/health` overlap; FE polls both

**Observed.**
- [/api/live/status](../../backend/server.py) at line 2777 returns ~13 fields (source, running, frame counts, uptime, perception flags…).
- [/api/admin/health](../../backend/server.py) at line 3279 returns nested `server` / `pipeline` / `integrations` / `perception` / `scene` / `ego` — most of the live/status fields again, plus more.
- FE: `useLiveStatus` polls every 5 s ([shared/hooks/useLiveStatus.ts](../../frontend/src/shared/hooks/useLiveStatus.ts:16)); `useAdminHealth` polls every 4 s ([features/admin/hooks/useAdminHealth.ts](../../frontend/src/features/admin/hooks/useAdminHealth.ts:8)). Dashboard mounts the first; Admin mounts the second; **Settings mounts both**.

**Why it matters.** Settings page open = ~22 status requests / minute for what is, in operator terms, a uptime pill in the TopBar. This is the canonical "too many API calls for not important UI" pattern.

**Options.**
- **(a)** Slow the polls for low-value UI: 4 s → 10 s for `useAdminHealth`, 5 s → 15 s for `useLiveStatus` on pages that only show the TopBar pill. **One-line change.**
- **(b)** Add `/api/live/snapshot` as a single superset endpoint; both FE hooks read it.
- **(c)** Make `/api/admin/health` a strict superset of `/api/live/status` and switch all callers.
- **(d)** Add `ETag` / `Last-Modified` so polls become conditional 304s.

**Trade-offs.**
- (a) costs nothing, immediately cuts traffic ~3×. Doesn't consolidate the API surface.
- (b) cleanest contract, single migration; needs a new endpoint name.
- (c) avoids a new endpoint but couples future health-page changes to the public live endpoint.
- (d) keeps two endpoints alive but cuts wire bytes; doesn't reduce request count or backend CPU.

**Recommendation.** **(a) first** — it's free. **(b) later**, once routers move out of `server.py` (item 2.1) so the consolidated endpoint has an obvious home.

### 4.2 Routes touch shared state without holding `state.lock`

**Observed.** [server.py:2777](../../backend/server.py) `live_status()` is `def` (sync — runs in the FastAPI thread pool) and reads `state.reader.frames_read`, `state.reader.frames_processed`, `state.episodes`, `state.recent_events`. The hot-path `_on_frame` mutates the same fields from the perception thread. Same pattern in `admin_health` (line 3279), `events` (line 2937), `summary` (line 3964).

**Why it matters.** Tearing reads under load — uptime can briefly read a `None` reader during a slot restart. Today it works because the GIL serializes pointer reads; that's an implementation accident, not a contract.

**Options.**
- **(a)** Acquire `state.lock` for any read that touches a field `_on_frame` writes.
- **(b)** Build a `LiveStateSnapshot()` method that takes the lock once and returns a frozen dataclass; routes consume the snapshot.
- **(c)** Leave it.

**Trade-offs.** (a) is correct but every route now needs the lock contract documented. (b) gives one canonical path and is more reviewable. (c) is "works today; one bad day from now."

**Recommendation.** **(b).** Aligns with the type-safety direction (1.2) and gives the FE a single typed `LiveStateSnapshot` model to consume.

### 4.3 MJPEG / polling endpoints have no cache headers

**Observed.** [server.py:3534](../../backend/server.py) `_mjpeg_response` and the polling fallback at line 3619 emit JPEGs without `Cache-Control: no-store` (`StreamImage` polls `/admin/frame/{id}` every 400 ms when not over HTTP/2). No `Last-Modified` either.

**Why it matters.** Some intermediaries cache aggressively; an MJPEG burst can get pinned. Polling fallback re-fetches even when the perception thread hasn't produced a new frame.

**Options.** (a) Add explicit `Cache-Control: no-store` on the MJPEG response and `ETag` derived from `slot._frame_ts` on the polling response. (b) Leave; deployment guidance in [CLAUDE.md](../../CLAUDE.md) already says to front with HTTP/2.

**Recommendation.** **(a)** for the polling fallback (cheap and helps dev mode). MJPEG is fine.

---

## 5. Model performance

### 5.1 Hot path is one 430-line function

**Observed.** `_on_frame` at [server.py:1396–1832](../../backend/server.py) executes 16 numbered gates inline (YOLO → quality → ego → scene → track-history update → interactions → depth gate → convergence gate → ego-relative motion gate → pair TTC → approach-required scrub → quality-adjusted classify → per-type floors → cooldown → episode open/update → idle-flush). Comments warn `do not short-circuit these gates`.

**Why it matters.** The system's correctness lives in this function and there's no way to test gate 11 independently of gates 1–10. Any change has to run end-to-end through `tests/test_core.py`.

**Options.**
- **(a)** Define a `Gate` protocol (`run(ctx) -> ctx | None`); one gate per file under `backend/pipeline/gates/`. Pipeline is `for gate in gates: ctx = gate.run(ctx) or break`.
- **(b)** Keep `_on_frame` monolithic but extract each numbered block into a private function in the same file with a `GateContext` dataclass for the shared inputs.
- **(c)** Leave as-is.

**Trade-offs.**
- (a) maximum testability + reorderability + per-gate metrics. Risk: someone reorders gates blindly, false-positive classes return.
- (b) half the win at a tenth of the risk. Each gate becomes a function with named inputs/outputs but lives next to its neighbours.
- (c) keeps the change-cost of any pipeline edit high.

**Recommendation.** **(b) first** as a stepping stone, then **(a)** once each gate has at least one regression test pinned from `tests/test_core.py`.

### 5.2 Single shared model + missing inference knobs

**Observed.** [core/detection.py:1140–1147](../../backend/core/detection.py):

```python
results = model.track(
    frame, persist=True, tracker=TRACKER_CFG, verbose=False
)[0]
```

- One global `state.model` shared across `StreamSlot`s. With N cameras at `TARGET_FPS=2`, ~2N inferences/s serialize through one call site.
- `imgsz`, `half`, `device` not passed — relies on ultralytics defaults (`imgsz=640`, `half=False`).
- `persist=True` shares ByteTrack state across cameras → potential track-ID collisions across slots.
- No model warmup in `lifespan` — the first real frame after boot pays JIT/MPS compile.
- Validator (RT-DETR-L, 66 MB) and MiDaS depth model load lazily on first use.

**Why it matters.** Multi-camera deployments are the common case; current shape doesn't batch. First-frame latency is high.

**Options.**
- **(a)** Pass `imgsz=`, `half=True` (CUDA only), explicit `device=` from config; warm up the model in `lifespan` with one synthetic 640×640 zero frame.
- **(b)** Also pre-load validator + depth weights at startup so first sample is hot.
- **(c)** Batch `model.track([f1, f2, ...])` per tick across slots; per-slot tracker config files to isolate ByteTrack state.
- **(d)** Optional ONNX export (`yolov8n.onnx` via `ultralytics export`) gated behind `ROAD_YOLO_BACKEND=onnx` for CPU deployments. *Speedup is implementation-dependent — needs benchmarking before any claim.*

**Trade-offs.**
- (a) zero new dependencies, predictable first-frame latency. Pure win.
- (b) trades startup time for steady-state latency — fine for a long-running edge process.
- (c) biggest throughput win for multi-camera; care needed on tracker config so IDs stay isolated.
- (d) deployment-target-dependent; should not be committed without measurement.

**Recommendation.** **(a) + (b)** in Plan A; **(c)** in Plan B; **(d)** opt-in feature flag in Plan B.

### 5.3 Config has no schema

**Observed.** [backend/config.py](../../backend/config.py) is 598 lines of `os.getenv("ROAD_X", default)` calls — ~70 env vars read at import time. No validation. A typo in `ROAD_TARGET_FPS` silently keeps the default.

**Why it matters.** Production misconfigurations are the silent kind: `ROAD_TARGET_FBS=4` boots happily.

**Options.**
- **(a)** `pydantic-settings.BaseSettings` — typed fields, validation at import, fail loud.
- **(b)** Hand-rolled validation function called from `lifespan`.
- **(c)** Leave.

**Recommendation.** **(a)** in Plan B. Adds one dependency, removes a class of silent prod bugs.

---

## 6. State coupling between perception and HTTP

**Observed.** Perception thread writes `state.X`; HTTP routes read `state.X`. Both live in the same module. There is no abstraction layer.

**Why it matters.** Cannot unit-test a route without booting the perception state. Cannot swap perception for a fixture in API tests.

**Options.**
- **(a)** Move `LiveState` to `backend/runtime/state.py`; routes get it via FastAPI dependency injection (`Depends(get_state)`); tests inject a fake.
- **(b)** Leave the global; add a snapshot method (item 4.2 (b)).

**Recommendation.** **(b)** as a stepping stone; **(a)** in Plan B.

---

## Summary table — backend findings → plans

| # | Finding | Plan A item | Plan B item |
| --- | --- | --- | --- |
| 1.1 | No type checker | A10 | B7 |
| 1.2 | `event` is `dict` | A5 | B3 |
| 2.1 | `server.py` god module | A6 | B1 |
| 2.2 | Inconsistent `api/` split | A6 | — |
| 2.3 | Privacy in wrong package | A6 (drive-by) | — |
| 3   | Other massive files | — (S effort, do alongside A6) | B1 (gate split) |
| 4.1 | `/live/status` + `/admin/health` overlap | A7 | — |
| 4.2 | Routes read state without lock | A7 (snapshot) | B5 |
| 4.3 | No cache headers on polling JPEG | A7 (drive-by) | — |
| 5.1 | `_on_frame` monolithic | — | B1 |
| 5.2 | Model perf knobs + warmup | A9 | B4 |
| 5.3 | No config schema | — | B2 |
| 6   | State coupling | A7 (snapshot) | B5 |

The detailed work-item descriptions, with effort + risk + files-touched tags, live in [plan-a-pragmatic.md](plan-a-pragmatic.md) and [plan-b-architectural.md](plan-b-architectural.md).
