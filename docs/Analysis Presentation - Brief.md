# Analysis Presentation — Brief

**Audience.** Reviewers / interviewers. Shows *how I audit a codebase and decide what to fix*, not a changelog.

**Per-entry shape.** Problem → Fix → Impact → Alternatives.

For full detail: [`Improvements and Refactoring - v.1.0.md`](Improvements%20and%20Refactoring%20-%20v.1.0.md). For the long-form presentation: [`Analysis Presentation - v.1.0.md`](Analysis%20Presentation%20-%20v.1.0.md).

---

## Audit framework — common areas I check

| Area | What I look for |
| --- | --- |
| Project structure | Cross-feature coupling, missing ownership boundaries |
| Giant / massive files | One file owns many concerns |
| Network | Ad-hoc fetches, no abort, inconsistent errors |
| State management | Hand-rolled caches, ad-hoc mutation |
| Hooks / lifecycle | Duplicated subscriptions, leaks on unmount |
| UI / reusable components | Copy-pasted widgets, style drift |
| Type safety | Types drift from runtime reality |
| Performance | Paying CPU/bandwidth for things no one sees |
| Error handling | One bug breaks everything |
| Privacy / security | Trust boundaries, PII leak surface |
| Resilience | One outage cascades through the app |
| Observability | Logs vs. actionable incidents |

---

# Frontend (FE)

## 1. Project structure
- **Problem.** Pages, hooks, widgets, API calls scattered. No ownership boundary — admin grid changes silently broke watchdog.
- **Fix.** `features/*` (admin, settings, watchdog, validation, dashboard, monitoring, tests) + `shared/*` (ui, hooks, lib, layout, config, events, types). **Import rule:** a feature imports from `shared/` or itself, never another feature.
- **Impact.** One engineer owns a feature end-to-end. Reviews per folder.
- **Alternatives.** Group by type (`/components`, `/hooks`) — splits one feature across folders. Monorepo (nx/turborepo) — overkill.

## 2. Giant / massive files
- **Problem.** `SettingsPage.tsx` (431 LoC) and `MultiSourceGrid.tsx` (341 LoC) did fetching + validation + rendering + dialogs.
- **Fix.** Decomposed into single-responsibility pieces: `Tunable`, `TunablesColumn`, `ImpactCard`, `OpsDeltas`, `ApplyResultBanner` + hooks (`useSettings`, `useSettingsApply`, `useImpact`) + `utils/`.
- **Impact.** Each piece unit-testable. Junior contributors can edit one widget without learning the whole flow.
- **Alternatives.** Split with comments only (no testability gain). Class components with inheritance (not idiomatic).

## 3. Network
- **Problem.** Each component rolled its own `fetch`. Different error shapes. No `AbortSignal` — unmounted components still wrote state.
- **Fix.** One `shared/lib/fetchClient.ts`: `apiFetch` (default `cache: "no-store"`, threads `AbortSignal`), `HttpApiError` (carries `status`, `body`, `retryAfterSec`, 422 details). All `useQuery`/`useMutation` go through it.
- **Impact.** Uniform errors. Auto-cancel on unmount. Debugging network issues = read one file.
- **Alternatives.** `axios` (bigger bundle, no gain over native `fetch`). Generated client from OpenAPI (later — needs `response_model=` everywhere first).

### 3a. MJPEG ↔ polling auto-switch *(transport choice)*
- **Problem.** Browsers cap HTTP/1.1 at **6 connections/host**. Each MJPEG stream holds one. 5+ tiles + SSE = browser stalls. But local dev is HTTP/1.1; production is HTTPS with HTTP/2 (multiplexes — cap dissolves).
- **Fix.** `StreamImage.tsx` auto-detects: HTTPS → MJPEG push; HTTP → poll `/admin/frame/{id}` every ~400ms. Override via `VITE_ROAD_VIDEO_TRANSPORT`.
- **Impact.** 8 tiles work locally on plain HTTP. Production gets push-based MJPEG. Zero operator config.
- **Alternatives.** WebRTC (sub-100ms but needs STUN/TURN/SFU — overkill at 2 fps). WebSockets + binary JPEGs (reimplements `<img src=multipart>`). HLS (6–10s latency, kills "live" feel).

## 4. State management
- **Problem.** Hand-rolled `setInterval` polling, local `useState` caches, manual revalidation. No dedupe — same resource fetched N times.
- **Fix.** **TanStack Query** for all server state. `useQuery` + `refetchInterval` (auto-cancels on unmount, pauses when tab hidden). `useMutation` + `onMutate` rollback for optimistic UI. `invalidateQueries` for cache busting. Deleted legacy `usePolling.ts` to make the rule enforceable.
- **Impact.** Shared cache → one network call serves N components. Stale-while-revalidate free. No zombie writes.
- **Alternatives.** Redux Toolkit + RTK Query (ceremony tax per slice, weaker Suspense/Abort story). SWR + Zustand (lighter but less polished mutations).

## 5. Hooks
- **Problem.** Every page had its own `EventSource`. 4 open pages = 4 connections to the same feed. State duplicated across components.
- **Fix.** `shared/hooks/`: `useSSE` (one connection, auto backoff/reconnect); `useEventStream` via `<EventStreamProvider>` — **single** EventSource for the main safety feed. Specialized feeds (`/admin/detections`) keep their own hook — rule is "don't duplicate ownership of the *same* stream."
- **Impact.** One subscriber per tab instead of N. Backoff/reconnect logic in one place.
- **Alternatives.** Redux middleware on a WebSocket (works, but SSE is one-way — doesn't need a store).

## 6. UI / reusable components
- **Problem.** Each feature hand-rolled buttons, cards, badges, empty states. Style drift + duplicated code.
- **Fix.** `shared/ui/`: `Button`, `Card`, `Dialog`, `EmptyState`, `ErrorBoundary`, `Pill`, `RiskBadge`, `Section`, `Skeleton`, `Spinner`, `Tabs`, etc. Plus `shared/layout/` (`PageChrome`, `TopBar`) and `shared/events/` (cross-feature event card/dialog).
- **Impact.** Visual consistency. Style change lands in one file. Features compose primitives.
- **Alternatives.** MUI/Chakra/shadcn (heavy, opinionated styling). Tailwind-only (class-name soup repeats per feature).

## 7. Type safety
- **Problem.** `shared/types/common.ts` was a 334-line **hand-mirrored** copy of backend shapes. Every backend rename silently desynced. "Source of truth in two places" = no source of truth.
- **Fix.** Pydantic models in `backend/api/models.py` → `scripts/generate_ts_types.py` → `frontend/src/shared/types/generated.ts` (462 LoC, machine-written). `common.ts` is now a 50-line re-export shim. `start.py` runs codegen *before* every Vite build — backend rename fails the build, not at runtime. `risk_level`/`stream_type` become string-literal unions; `bbox` becomes a 4-tuple.
- **Impact.** Wire contract physically generated. Field renames caught at compile time on both ends.
- **Alternatives.** `openapi-typescript` (needs `response_model=` everywhere first). `pydantic2ts` (extra dep — bespoke 60-line script gives full control).

## 8. Performance
- **Problem.** One bundle = `/settings` loads watchdog + admin + validation. Slow first paint. One feature's bug crashes whole SPA.
- **Fix.** **Lazy routes** via React Router — each page its own chunk wrapped in `<RouteShell>` (ErrorBoundary + Suspense). **Optimistic UI** with 8s "stuck-busy" escape on live-source mutations. **Background polling pause** (`refetchIntervalInBackground: false`) — hidden tabs stop hammering the server. (BE side: idle tiles skip JPEG encode via `StreamSlot.has_viewers`.)
- **Impact.** Per-feature error containment. Idle tabs cost ~zero. First paint scoped to current page.
- **Alternatives.** Next.js SSR (nothing to SSR on a live operator dashboard). Service worker + stale cache (complexity for little gain on always-online app).

## 9. Error handling & lifecycle
- **Problem.** One render error = white screen for the whole app. No visibility into which feature failed.
- **Fix.** `<RouteShell>` wraps every lazy route with its own `ErrorBoundary` + `Suspense`. `AbortSignal` everywhere. `DialogProvider` centralizes modal state.
- **Impact.** Partial failure instead of total. Cleaner StrictMode dev console.

## FE — Critical bugfixes
1. **Zombie state writes on unmount** → `AbortSignal` threaded through `apiFetch` + every `useQuery`.
2. **Stuck "applying…" state** on settings apply → 8-second escape timer + explicit failure banner.
3. **Browser connection exhaustion** at 5+ tiles → MJPEG/poll auto-switch.
4. **Duplicated SSE subscribers** (N per open tab) → shared `<EventStreamProvider>`.
5. **Silent type drift** between BE and FE → Pydantic → TS codegen pipeline.
6. **White-screen crashes** from one feature taking out the rest → per-route error boundaries.

## FE — Best practices applied
- Feature folders > type folders (ownership beats categorization).
- One place for the fetch layer (errors, abort, headers — one file).
- Server state ≠ client state — cache (TanStack) for first; `useState`/context for second.
- Codegen the contract; never hand-mirror backend types.
- Lazy-load per route — isolate bundles *and* failures.
- Always thread `AbortSignal` on unmount.
- Document rules (`.claude/rules/frontend.md`) so they outlive memory.

## FE — Best judgments (what I chose *not* to do)
- **No Redux.** Server state is a cache problem, not a store problem.
- **No design system import.** Bespoke `shared/ui/` fits the operator-dashboard look.
- **No SSR.** Operator SPA with live streams — nothing to server-render.
- **No WebRTC.** At 2 fps, frame-period latency is invisible — infra tax not worth it.
- **Templates UI trimmed back** (BE endpoints retained) — shipped core apply+impact loop first.

---

# Backend (BE)

## 1. Project structure
- **Problem.** `road_safety/server.py` was a **1,535-line monolith** mixing 37 HTTP routes with business logic, live state, and domain models. Every feature was a merge conflict.
- **Fix.** Split into `backend/{core, perception, services, api, integrations, compliance, security, rendering, domain}`. `state.py` owns singletons only. `server.py` shrinks to **189 lines** (composition root — wires routers + lifespan).
- **Impact.** Each module independently testable. New features land as new files, not 300-line diffs in `server.py`.
- **Alternatives.** Hexagonal/clean architecture (3× file count, ceremony tax — overkill for single-process POC). Keep monolith + in-file `APIRouter` blocks (still merge-conflict magnet, can't mount routers into isolated test apps).

## 2. Giant / massive files
- **Problem.** `server.py` 1,535 LoC. `watchdog.py` ~1,800 LoC (rules + AI + storage + orchestration in one file). `state.py` 791 LoC.
- **Fix.** `server.py` → 189 LoC. `watchdog.py` → `backend/services/watchdog/` package: `model.py` (dataclass + fingerprinting), `rules.py` (deterministic detectors), `ai.py` (Claude — strictly additive), `storage.py` (JSONL I/O), `api.py` (loop + `stats()`). `state.py` 791 → 400 LoC (`Episode`, `StreamSlot` moved to `backend/domain/`).
- **Remaining candidates.** `services/impact.py` (813 LoC), `api/settings.py` (640 LoC).
- **Impact.** Each concern testable in isolation. Rules exercisable without booting the loop. AI layer stub-able offline.

## 3. Network / API organization
- **Problem.** 37 routes as `@app.*` decorators in one file. Impossible to test one route without booting the whole app.
- **Fix.** **15 feature routers** under `backend/api/routers/` + 2 function-mounted (`feedback.py`, `settings.py`): `live` (344), `sources` (208), `admin_health` (145), `sse` (130), `watchdog` (129), `spa` (110), `agents` (101), `admin_video` (94), …7 smaller. Pydantic response models in `api/models.py`.
- **Impact.** `tests/test_settings_api.py` mounts *only* the settings router in a fresh `FastAPI()`. No perception boot. No global state.
- **Alternatives.** Group by HTTP verb (one feature spans 3 files). Class-based controllers (non-idiomatic FastAPI, breaks dependency-override testing).

## 4. Performance & concurrency
- **Problem.** Hot path runs at TARGET_FPS per source. Reading mutable config dicts → races on partial reads; lock-per-read burns CPU under contention.
- **Fix.** `SettingsStore` with **snapshot isolation**: writers take a short `RLock`, validate, build a new immutable `MappingProxyType`, atomically rebind. **Readers call `STORE.snapshot()` lock-free.** Subscribers notified outside the lock, each in its own `try/except`. `last_known_good` captured before each apply → rollback is a pointer swap.
- **Invariants.** Reader never blocks writer. Writer never blocks readers. No partial diffs ever visible.
- **Impact.** Hot path stays nanosecond-cheap. Operators can tune at runtime with zero contention.
- **Alternatives.** Mutex per read (wrong order of magnitude). COW dict + queue (still allocates, adds latency). SQLite per access (microseconds per read, partial-read window returns).

## 5. State management
- **Problem.** Live state (per-source streams, episodes, viewer counts) lived as dict-of-dicts in `server.py`, mutated from everywhere.
- **Fix.** `backend/domain/stream_slot.py` (one `StreamSlot` per source — viewer tracking, MJPEG sub count, per-slot `detection_enabled`). `backend/domain/episode.py` (one `Episode` per active incident). `backend/state.py` thin module owning singletons only. `SettingsStore` for config (above).
- **Impact.** State changes go through typed methods. Tests construct fresh `StreamSlot` directly — no boot.
- **Alternatives.** Module-level dicts (what we had — doesn't scale). Redis (deploy complexity for single-process edge). Pydantic models for state (validation cost on every write — state is hot, config is cold; different tools).

## 6. Type safety
- **Problem.** No static type checking. Refactor errors (renaming a model field) only surfaced at runtime, sometimes hours into a session.
- **Fix.** **Two-tier `mypy`** on the boundary:
  - **Tier 1** — `backend.api.models` (the wire contract): fully strict.
  - **Tier 2** — `backend/api/` routers + `services/llm.py` (failure-sensitive): strict minus `disallow_untyped_defs` (handler returns are already constrained by `response_model=`).
  - Third-party stubs relaxed (`cv2`, `numpy`, `ultralytics`).
  - Companion: `pyright` at `basic` over the included tree (`make typecheck`) for IDE feedback.
- **Why narrow?** Wire contracts and the LLM resilience layer are the two most failure-sensitive surfaces. Typing the perception hot path against `numpy`/`cv2` would burn weeks for marginal value.
- **Impact.** Wire boundary is type-checked end-to-end (Pydantic in + mypy on slice + codegen → TS-strict on FE).
- **Alternatives.** `pyright` only (different guarantees). `mypy --strict` everywhere (blocks weeks on `numpy`-heavy code). No static typing at all (errors surface in production).

## 7. Privacy & security
### 7a. Plate hashing at ingest (not egress)
- **Problem.** Plate text is PII (GDPR). "Scrub at egress" = every consumer must remember; one forgotten `return event` = leak.
- **Fix.** `enrich_event()` in `services/llm.py` hashes the plate and **strips `plate_text`/`plate_state` before** the event reaches any buffer. `perception/emit.py` keeps a defense-in-depth `pop()`. Encoded in `CLAUDE.md` + `.claude/rules/python.md`.
- **Impact.** Plate read once in a controlled LLM call. A future buffer consumer **cannot** leak — the field doesn't exist in memory.
- **Alternatives.** Egress scrub (convention — one miss = leak). KMS-encrypted at rest, decrypt at egress (per-event KMS hop, plate still briefly cleartext).

### 7b. SSRF guard + rate limits
- **Problem.** Operator-supplied URLs (adding a stream) could point at `localhost:5432`, AWS metadata IP, etc. — classic SSRF.
- **Fix.** `backend/security/ssrf.py::validate_public_url()` rejects private/loopback/link-local. `backend/security/rate_limit.py` caps per-IP clip renders.
- **Impact.** Operator/attacker via UI cannot make the edge fetch internal endpoints.

### 7c. Edge → cloud HMAC
- **Problem.** Cloud receiver accepting unsigned batches = PII firehose for anyone who guesses the URL.
- **Fix.** Every batch HMAC-signed over the payload. Receiver verifies before touching it; deduplicates on event id (retries safe).
- **Impact.** TLS proves *who* you're talking to; HMAC proves the batch was minted by an authorized edge. Works air-gapped.
- **Alternatives.** TLS alone (URL-guess = forge). OAuth client-credentials (needs an IdP every edge can reach — incompatible with air-gap). Managed broker / SQS (vendor-coupled, no on-prem story).

## 8. Resilience — single LLM egress, failover, cost ceiling
- **Problem.** Calling Claude from 5 places = one outage from being unable to start. No single place for breaker, cost cap, or retry policy.
- **Fix.** All LLM calls through `backend/services/llm.py`. Nothing else imports an SDK (enforced in `.claude/rules/python.md`). Owns: provider failover (Anthropic + Azure OpenAI — Azure wins when both configured), per-min/hour rate budget, circuit breaker on consecutive failures, cost tracking (`/api/llm/stats`), plate hashing in `enrich_event`, no-network stub mode for tests.
- **Impact.** Anthropic returns 529? Watchdog still runs (rules-only). Enrichment falls back to secondary or skips. Cost meter prevents a runaway retry loop.
- **Alternatives.** Each consumer calls SDK directly (breaker fragments, cost untrackable, privacy invariant duplicated N times). LangChain (heavy, opinionated chains we don't need). Sidecar service (extra deploy + network hop, re-opens plate-handling surface).

## 9. Observability — watchdog as an incident queue
- **Problem.** "Error logs" get tuned out within a week. Operators need *what to do*, not *what happened*.
- **Fix.** Findings carry `severity`, `category`, `impact`, `likely_cause`, `owner`, `evidence`, `investigation_steps`, `debug_commands`, `runbook`, `priority_score`, `source` (`rule`|`ai`), `cause_confidence`. Grouped by `fingerprint` — repeated symptoms collapse into one ticket. **Two layers:** rules (deterministic, always available) and AI hypothesis (Claude — strictly additive, dedupe against rules). **Invariant:** monitoring never *depends* on the LLM.
- **Impact.** Operators get "paste this `curl` to reproduce" instead of a log wall. Monitoring survives provider outages.
- **Alternatives.** Datadog/Sentry (mature UI but no perception-domain rules and needs outbound internet). Rules only (misses novel patterns). LLM-first with rules as fallback (violates "monitoring must survive outages").

## BE — Critical bugfixes
1. **Hot-path config race** → `SettingsStore` snapshot isolation (atomic pointer swap).
2. **Lost-update on concurrent settings edits** → `If-Match: expected_revision_hash` returns 409; per-token/IP 5s apply cooldown; single-use 30s SSE tickets.
3. **PII leak risk in event buffers** → plate hash at ingest + strip fields.
4. **Cascading LLM outages** → circuit breaker + provider failover + rules-only watchdog fallback.
5. **Forged cloud ingest** → HMAC-signed batches + idempotent receiver.
6. **SSRF via stream URL input** → `validate_public_url()` guard.
7. **Inference CPU burn on idle tiles** → `StreamSlot.has_viewers`: encode only when watched.
8. **Ad-hoc FPS/CPU estimates** → `psutil`-backed ops sampler feeding ImpactMonitor.
9. **Watchdog loop blocked on LLM** → AI hypothesis moved to async, rules-first pattern.
10. **Subscriber crash poisoning apply chain** → each subscriber wrapped in `try/except`; errors counted, never roll back the apply.

## BE — Best practices applied
- **Composition root.** `server.py` wires; doesn't contain logic.
- **One egress per concern.** All LLM calls via `services/llm.py`; all settings writes via `SettingsStore.apply_diff()`.
- **Immutable snapshots for hot-path config** — readers never block writers; no partial reads.
- **Rules before AI** — deterministic floor; AI is additive and deduplicated.
- **Message auth, not just transport auth** — HMAC on edge→cloud.
- **Defense in depth** — plate hash at ingest *and* defensive `pop()` at egress.
- **Static typing on the boundary** — wire contract is mypy-strict.
- **Pydantic models as source of truth** — codegen to TypeScript.
- **Atomic diffs with rollback** — `last_known_good` + pointer swap.
- **Document invariants** — `CLAUDE.md` + `.claude/rules/*.md` turn tribal knowledge into enforceable text.

## BE — Best judgments (what I chose *not* to do)
- **No auth in the POC.** Half-built auth is worse than none — operators assume it protects, and it doesn't. Documented in README + `CLAUDE.md`. HMAC + audit log still in place where they matter.
- **No full hexagonal architecture.** Triples file count for a single-process POC.
- **No feature-flag SaaS** (LaunchDarkly/Unleash) — doesn't do statistical impact gating, the actual differentiator.
- **No etcd/Consul** for config — overkill for one process; SQLite for durable history is enough.
- **No OpenAPI-to-TS yet** — needs `response_model=` discipline on 100% of handlers first.
- **No full-codebase mypy strict** — typing `numpy`/`cv2` is weeks of cleanup for marginal value.
- **Dashcam code fully stripped, not flag-gated** — two products fighting in one repo produce contradictory gate behavior. `dashcam-last-known-good` branch keeps the archaeology path.

---

## Summary table — FE vs BE per area

| Area | Frontend fix | Backend fix |
| --- | --- | --- |
| Project structure | Feature folders + import rule | `backend/{core,perception,services,api,…}` |
| Giant files | `SettingsPage`, `MultiSourceGrid` decomposed | `server.py` 1535→189; `watchdog/` package |
| Network | `apiFetch` + `HttpApiError` + `AbortSignal` | 15 routers + HMAC ingest + SSRF guard |
| State management | TanStack Query | `SettingsStore` snapshot isolation |
| Hooks / lifecycle | Single `<EventStreamProvider>`, `useSSE` | `StreamSlot` viewer tracking |
| UI / reusable | `shared/ui/` library | (n/a) |
| Type safety | Generated TS from Pydantic | Two-tier `mypy` on boundary |
| Performance | Lazy routes, background pause, MJPEG/poll | Encode-on-demand, lock-free reads |
| Error handling | Per-route `ErrorBoundary` | Circuit breaker + rules-only fallback |
| Privacy / security | (n/a) | Plate hash at ingest, HMAC, SSRF |
| Resilience | (n/a) | Single LLM egress + failover + cost cap |
| Observability | (n/a) | Watchdog fingerprinted incident queue |

---

## How I'd present this in 5 minutes

1. **Show the framework first** — the 12-row "common areas" table. *"These are the buckets I audit any codebase by."*
2. **Pick two deep dives** that show judgment, not just work:
   - **BE:** `SettingsStore` snapshot isolation (concurrency under hot-path reads).
   - **FE:** MJPEG ↔ poll auto-switch (network constraints driving design).
3. **Volunteer one gap** — *"Auth is the biggest product-readiness gap, here's why I didn't half-build it."* Engineering judgment beats feature enthusiasm.
4. **One alternative per topic** — *"I considered X; rejected because Y."* Proves I chose, didn't just do.
