# Key Improvements & Bugfixes — Presentation Deck

**Goal of this doc.** Walk a reviewer through *how I analyze a codebase*, what I fixed, and why — filtered to the **most impactful** items only. Noise removed.

**How to read each entry.**
- **Problem** — what was wrong, how I spotted it.
- **Why it mattered** — the real cost (bug class, performance, PII, DX).
- **Fix** — what I did.
- **Impact** — what this unlocks or prevents.
- **Alternatives considered** — what I rejected and why.

**Full detail:** see [Improvements and Refactoring - v.1.0.md](Improvements%20and%20Refactoring%20-%20v.1.0.md) and [Analysis Presentation - v.1.0.md](Analysis%20Presentation%20-%20v.1.0.md).

---

## Analysis framework — the common areas I audit

| Area | What I look for |
| --- | --- |
| **Project structure** | Cross-feature coupling; one-folder ownership boundaries. |
| **Giant / massive files** | Single file owning many concerns → unreviewable, untestable. |
| **Network layer** | Ad-hoc `fetch` calls, inconsistent error shapes, no abort. |
| **State management** | Hand-rolled caches, duplicated fetches, zombie writes. |
| **Hooks / lifecycle** | Duplicated subscriptions, missing cleanup, race conditions. |
| **UI / reusable components** | Copy-pasted widgets, inconsistent styling. |
| **Type safety** | Types drifting from the wire reality. |
| **Performance** | Paying for work nobody is watching. |
| **Error handling** | One bug cascades and breaks everything else. |
| **Privacy / security** | Trust boundaries, PII in buffers, unauthenticated ingest. |
| **Resilience** | Third-party outages cascading into core product. |
| **Observability** | "Logs" vs. "incidents with next action". |

Same lens applied to **FE** and **BE** below.

---

# 1. Frontend (FE)

## 1.1 Project structure

- **Problem.** Pages, hooks, shared widgets, and API calls were scattered by type (`/components`, `/pages`, `/hooks`). A change in the admin grid could silently break the watchdog drawer.
- **Why it mattered.** No ownership boundary → reviews touch multiple folders; one engineer cannot own a feature.
- **Fix.** Feature folders under `frontend/src/features/*` (`admin`, `settings`, `watchdog`, `validation`, `dashboard`, `monitoring`, `tests`), each with its own components/hooks/`api.ts`. Shared code in `shared/` (`ui/`, `hooks/`, `lib/`, `layout/`, `events/`, `config/runtime.ts`). **Import rule:** a feature imports from `shared/` or itself — never from another feature.
- **Impact.** One engineer owns a feature end-to-end. Reviews are per-folder. Breaking one feature can't silently leak into another.
- **Alternatives.** Group by type (classic, doesn't scale); monorepo (`nx`/`turborepo`) — overkill for one SPA.

## 1.2 Giant / massive files

- **Problem.** `SettingsPage.tsx` was 431 LoC, `MultiSourceGrid.tsx` 341 LoC — both mixed fetching, validation, rendering, dialogs. Impossible to test or review.
- **Why it mattered.** Every edit was a merge conflict; junior contributors couldn't touch them safely.
- **Fix.** Decomposed into small, named components with one job each.
  - Settings → `SettingsPage`, `Tunable`, `TunablesColumn`, `ImpactCard`, `OpsDeltas`, `ApplyResultBanner`, `SeverityBars`, `LivePreviewCard`, `SettingsHeader` + hooks (`useSettings`, `useSettingsApply`, `useImpact`) + `utils/`.
  - Admin grid → `MultiSourceGrid`, `StreamTile`, `StreamImage`, `HealthStrip`, `AdminEventCard`.
- **Impact.** Each piece is unit-testable. A junior can edit a `Tunable` without understanding the full settings flow.
- **Alternatives.** Keep one file, split with comments (doesn't help testability); class components with inheritance (non-idiomatic today).

## 1.3 Network layer

- **Problem.** Every component rolled its own `fetch(...)`. Error shapes differed. No `AbortSignal` — unmounting during a fetch caused zombie state writes and StrictMode warnings.
- **Why it mattered.** Inconsistent UX on 422/429 errors; debugging meant grepping twenty files.
- **Fix.** Central `shared/lib/fetchClient.ts`:
  - `apiFetch(url, opts)` — `cache: "no-store"`, threads `AbortSignal`, infers content type.
  - `HttpApiError` — structured error with `status`, `body`, `retryAfterSec` (HTTP 429), 422 validation details.
  - Every `useQuery` / `useMutation` goes through it.
- **Impact.** Unmount cancellation is automatic. Rate-limit and validation errors render consistently. Debugging = reading one file.
- **Alternatives.** `axios` (bigger bundle); OpenAPI-generated client (needs 100% `response_model=` on BE first).

### 1.3.a Transport choice — MJPEG vs polling auto-switch

- **Problem.** Browsers cap HTTP/1.1 at **6 concurrent connections per host**. One MJPEG stream per tile + SSE = stalls at 5+ tiles. Local dev is HTTP/1.1; production is HTTPS / HTTP/2 (multiplexes, no cap).
- **Why it mattered.** Either dev breaks or prod latency suffers — can't have both with one transport.
- **Fix.** `StreamImage.tsx` auto-detects: `window.location.protocol === "https:"` → MJPEG push; HTTP → polling `/admin/frame/{id}` every ~400ms. Override via `VITE_ROAD_VIDEO_TRANSPORT`.
- **Impact.** Dev works with 8 tiles on plain HTTP; prod gets push-based MJPEG with no polling floor. Zero operator config.
- **Alternatives.** WebRTC everywhere (sub-100ms but needs STUN/TURN/SFU — overkill at 2 fps); WebSocket + binary JPEG (reimplements what `<img src=multipart>` gives natively); HLS (6–10s latency floor, kills "live" feel).

## 1.4 State management

- **Problem.** Hand-rolled `setInterval` polling, local `useState` caches, manual revalidation. No dedupe across components asking for the same resource. Data got stale and no one knew when to refresh.
- **Why it mattered.** N components → N duplicate requests; impossible to coordinate invalidation after a mutation.
- **Fix.** **TanStack Query** for all server state:
  - `useQuery` with `refetchInterval` (auto-cancels on unmount; `refetchIntervalInBackground: false` pauses hidden tabs).
  - `useMutation` + `onMutate` rollback for optimistic UI.
  - `invalidateQueries(...)` replaces manual "refetch after POST".
  - Deleted legacy `shared/hooks/usePolling.ts` to make the rule enforceable.
- **Impact.** Shared cache → one request serves N components. Background refresh + stale-while-revalidate free. No zombie writes.
- **Alternatives.** Redux Toolkit + RTK Query (ceremony tax per slice); SWR + Zustand (less polished mutation/rollback story).

## 1.5 Hooks

*Concept: a React "hook" is a reusable function that lets a component subscribe to state or side effects (e.g. `useState`, `useEffect`).*

- **Problem.** Every page opened its own `EventSource` to the SSE feed. Four open pages = four connections to the same stream. Backoff/reconnect duplicated everywhere.
- **Why it mattered.** Server-side subscriber count inflated; reconnect logic diverged per component.
- **Fix.** Shared hooks in `shared/hooks/`:
  - `useSSE` — one connection per stream with automatic backoff + reconnect.
  - `useEventStream` (context-based) — **single** EventSource for the main safety-event feed via `<EventStreamProvider>`. Specialized feeds (e.g. `/admin/detections`) keep their own hook — rule is "don't duplicate ownership of the **same** stream".
  - `useLiveStatus`, `useUptimeTicker` — small, focused, clear contracts.
- **Impact.** One subscriber per tab, not N. Backoff lives in one place.
- **Alternatives.** Redux middleware for WebSocket (SSE is one-way, simpler, doesn't need a store).

## 1.6 UI / reusable components

- **Problem.** Every feature hand-rolled its own buttons, cards, badges, empty states. Inconsistent styling + duplicated code.
- **Why it mattered.** Design drift; any style tweak touched many files.
- **Fix.** `shared/ui/` primitives — `Button`, `Card`, `Dialog`, `EmptyState`, `ErrorBoundary`, `Input`, `Pill`, `RiskBadge`, `Section`, `Skeleton`, `Spinner`, `Tabs`, `Tag`, `Dot` + `shared/layout/` + `shared/events/`.
- **Impact.** Visual consistency. Style changes land in one file. Features shrink — compose primitives instead of reinventing.
- **Alternatives.** MUI / Chakra / shadcn (heavy, opinionated aesthetic fights the operator look); Tailwind-only (class-name soup per feature).

## 1.7 Type safety

- **Problem.** `shared/types/common.ts` was 334 LoC of hand-mirrored backend shapes. Every backend rename silently desynced — surfaced as runtime parse errors in StrictMode dev.
- **Why it mattered.** "Source of truth in two places" = no source of truth. Refactors were scary.
- **Fix.** Pydantic models in `backend/api/models.py` → `scripts/generate_ts_types.py` → `frontend/src/shared/types/generated.ts` (462 LoC, machine-written). `common.ts` is now a 50-line re-export shim (no existing imports break). `start.py` runs codegen **before** every Vite build — backend renames fail the build loudly, not at runtime.
- **Impact.** Wire contract physically generated from backend. Field renames caught at compile time. Bonus: `risk_level`/`stream_type` become string-literal unions; `bbox` is a 4-tuple (safe under `noUncheckedIndexedAccess`).
- **Alternatives.** `openapi-typescript` (needs `response_model=` on every handler); `pydantic2ts` (another dep; bespoke 60-line script gives full control).

## 1.8 Performance

- **Problem.** One bundle for everything — `/settings` loaded the watchdog + admin + validation code. Slow first paint, and a bug in one feature could crash the whole SPA.
- **Why it mattered.** Operators open one page at a time; paying for the others is wasted bytes + a blast-radius risk.
- **Fix.**
  - **Lazy routes** via React Router — each page is its own `import()` chunk, wrapped in `<RouteShell>` (ErrorBoundary + Suspense).
  - **Optimistic UI** with an 8-second "stuck-busy" escape on live-source mutations.
  - **Idle encode skip (BE):** `StreamSlot.has_viewers` — stop JPEG encoding when nobody is watching.
  - **Background pause:** `refetchIntervalInBackground: false` stops hidden tabs from hammering the server.
- **Impact.** Settings page no longer pays for the watchdog bundle. Per-feature errors contained. Idle tabs cost ~zero.
- **Alternatives.** SSR via Next.js (nothing to SSR on a live operator dashboard); service worker caching (complexity > gain for always-online app).

## 1.9 Error boundaries & lifecycle

- **Problem.** One rendering error → white screen for the whole app. No visibility into which feature failed.
- **Why it mattered.** Partial failure is recoverable; total failure is an outage.
- **Fix.** `<RouteShell>` wraps every lazy route with its own `ErrorBoundary` + `Suspense`. `AbortSignal` threaded everywhere. `DialogProvider` centralizes modal state so dialogs don't fight each other.
- **Impact.** Partial failure instead of total failure. Cleaner dev console in StrictMode.

## 1.10 Critical bugfixes (FE)

1. **Zombie state writes on unmount** → `AbortSignal` through `apiFetch` + every `useQuery`. React no longer warns; StrictMode double-invoke is clean.
2. **Stuck "applying…" state** on settings apply after network hiccup → 8-second escape timer + explicit failure banner.
3. **Browser connection exhaustion** at 5+ tiles → MJPEG/poll auto-switch (§1.3.a).
4. **Duplicated SSE subscribers** per tab → shared `<EventStreamProvider>`.
5. **Silent type drift** between backend and frontend → codegen pipeline (§1.7).
6. **White-screen crash from one broken feature** → per-route error boundaries.

## 1.11 Best practices applied (FE)

- Feature folders > type folders. **Ownership beats categorization.**
- **One fetch layer.** All HTTP goes through `apiFetch`.
- **Server state ≠ client state** — TanStack Query for the first, `useState`/context for the second.
- **Codegen the contract.** Never hand-mirror backend types.
- **Lazy-load per route.** Isolate bundles and failures.
- **Cancel on unmount.** Always thread `AbortSignal`.
- **Document the rules.** `.claude/rules/frontend.md` encodes the import rule, SSE-ownership rule, no-hand-rolled-polling rule.

## 1.12 Best judgments (what I chose *not* to do — FE)

- **No Redux.** Server state is a cache problem, not a store problem. TanStack Query is the right tool.
- **No design system import.** Bespoke `shared/ui/` fits the product; heavy libraries fight the operator aesthetic.
- **No SSR.** Operator SPA with live streams has nothing to server-render.
- **No WebRTC.** At 2 fps inference, frame-period latency is invisible; STUN/TURN/SFU tax not worth it.
- **Templates UI trimmed back** (backend endpoints retained). Shipped the apply+impact loop first rather than extending an unproven UX.

---

# 2. Backend (BE)

## 2.1 Project structure

*Concept: a Python "package" is a folder with `__init__.py`; a "module" is a `.py` file. FastAPI "routers" group related endpoints.*

- **Problem.** Everything lived in `road_safety/server.py` — **1,535 lines** mixing 37 HTTP routes, live state, and domain models. Every feature was a merge conflict.
- **Why it mattered.** Zero testability — you couldn't mount one router in a fresh `FastAPI()` without dragging in perception boot + global state.
- **Fix.** Feature packages under `backend/`:
  - `core/` — perception (detection, stream, egomotion, quality, context).
  - `perception/` — hot-path inference + emit + broadcast.
  - `services/` — LLM, drift, watchdog, impact, registry, redact, agents.
  - `api/` — routers + Pydantic models.
  - `domain/` — `Episode`, `StreamSlot` (extracted from shared state).
  - `integrations/`, `compliance/`, `security/`, `rendering/`.
  - `state.py` — singletons only.
  - `server.py` → **189 lines** (pure composition root — wires routers + lifespan).
- **Impact.** Each module is independently testable. New features land as new files, not 300-line diffs inside `server.py`. A new engineer reads `server.py` in one screen.
- **Alternatives.** Hexagonal / clean architecture (3× file count, ceremony tax — overkill); keep monolith with `APIRouter` blocks (same merge-conflict magnet, untestable).

## 2.2 Giant / massive files

- **Problem.**
  - `server.py` — 1,535 LoC (routes + state + logic mixed).
  - `watchdog.py` — ~1,800 LoC (rules + AI + storage + orchestration in one file).
  - `state.py` — 791 LoC (singletons + domain classes intermingled).
- **Why it mattered.** Any change to one concern forced reviewers to scan a whole file about four other concerns.
- **Fix.**
  - `server.py` → 189 LoC composition root.
  - `watchdog.py` → `backend/services/watchdog/` package:
    - `model.py` — dataclass + fingerprinting + grouping.
    - `rules.py` — deterministic rule-based detectors (always available).
    - `ai.py` — Claude hypothesis layer (strictly additive, returns `[]` on outage).
    - `storage.py` — append-only JSONL I/O.
    - `api.py` — background loop + `stats()`.
  - `state.py` 791 → 400 LoC — `Episode` and `StreamSlot` moved to `backend/domain/`, re-exported for backward compat.
- **Remaining candidates.** `backend/services/impact.py` (813 LoC), `backend/api/settings.py` (640 LoC — the SSE + ticket exchange could move out).
- **Impact.** Each concern testable in isolation. Rules exercisable without booting the loop. AI layer stubbable for offline tests.

## 2.3 Network / API organization

- **Problem.** 37 `@app.get(...)` decorators in one file. Impossible to test one route without booting the whole app.
- **Why it mattered.** Every test needed full perception boot (30s+); shared state caused order-dependent flakes.
- **Fix.** **15 feature routers** under `backend/api/routers/` + 2 function-mounted routers. Shared Pydantic response models in `backend/api/models.py`.

  | Router | LoC | | Router | LoC |
  | --- | ---: | --- | --- | ---: |
  | `live.py` | 344 | | `admin_video.py` | 94 |
  | `sources.py` | 208 | | `road.py` | 48 |
  | `admin_health.py` | 145 | | `thumbnails.py` | 46 |
  | `sse.py` | 130 | | `tests.py` | 39 |
  | `watchdog.py` | 129 | | `llm_obs.py` | 39 |
  | `spa.py` | 110 | | `audit.py` | 37 |
  | `agents.py` | 101 | | `retention.py` | 28 |

- **Impact.** `tests/test_settings_api.py` mounts **only** the settings router in a fresh `FastAPI()` — no perception boot, no global state. Per-router review and CI isolation.
- **Alternatives.** Group by HTTP verb (a single feature spans 3 files); collapse into 4–5 big routers (`live.py` re-drifts to 800 LoC); class-based controllers (non-idiomatic, breaks dependency-override testing).

## 2.4 Performance & concurrency — hot-path config

- **Problem.** Perception runs at `TARGET_FPS` per source and reads config every gate. A shared mutable dict risked partial reads during a write; a lock per read would burn CPU under contention.
- **Why it mattered.** Config is read millions of times per minute; write contention would show up as jitter on the detection hot path.
- **Fix.** `SettingsStore` with **snapshot isolation**:
  - Writers take a short `RLock`, validate the diff, build a new immutable `MappingProxyType` (Python's read-only dict view), atomically rebind the module-level reference, release the lock.
  - Readers call `STORE.snapshot()` — **lock-free**. They hold the snapshot current at call time even if a write completes mid-handler.
  - Subscribers notified **outside** the lock; each in its own `try/except` (a buggy listener can't poison the apply chain).
  - `last_known_good` captured before each apply → `POST /api/settings/rollback` is a pointer swap, not re-validate.
- **Invariants.** A reader never blocks a writer; a writer never blocks readers; no one ever sees a partially-applied diff.
- **Impact.** Hot path stays nanosecond-cheap. Operators tune thresholds at runtime with zero contention jitter.
- **Alternatives.** Mutex per read (wrong order of magnitude); copy-on-write dict + writer queue (still allocates, adds queue latency); SQLite per read (microseconds per read; reintroduces partial-read window).

## 2.5 Type safety

- **Problem.** No static type checking. Refactor errors (renaming a model field) surfaced at runtime, sometimes hours into a session.
- **Why it mattered.** Perception sessions are long-running; a late-binding error is expensive to reproduce.
- **Fix.** Two-tier `mypy` on the boundary:
  - **Tier 1 — `backend.api.models` (the wire contract):** fully strict (`disallow_untyped_defs = true`).
  - **Tier 2 — `backend/api` routers + `backend/services/llm.py`:** strict minus `disallow_untyped_defs` (handler returns already constrained by FastAPI's `response_model=`).
  - **Third-party stubs** relaxed for `cv2`, `numpy`, `ultralytics`, etc.
  - Shipping the scope required real type fixes — `_CB_STATE` as a `TypedDict` (fixed 4 operand errors around the circuit breaker); `_resolve_slot(source_id)` helper to stop `StreamSlot | None` rebinding across branches.
  - Companion: `pyright` at `basic` over the included tree (`make typecheck`) for IDE feedback.
- **Impact.** Wire boundary type-checked end-to-end: Pydantic in → mypy-strict on the slice → codegen → TypeScript-strict on FE. Refactors surface at build, not runtime.
- **Alternatives.** `pyright` only (different guarantees, no Pydantic plugin); `mypy --strict` everywhere (weeks of `numpy` cleanup for marginal gain).

## 2.6 State management

- **Problem.** Live state (per-source streams, episodes, viewer counts) lived as dict-of-dicts in `server.py`, mutated from everywhere.
- **Why it mattered.** No typed surface → no confidence any caller respected invariants.
- **Fix.**
  - `backend/domain/stream_slot.py` — one `StreamSlot` per live source: viewer tracking (`mark_polled`, `has_viewers`), MJPEG subscriber count, per-slot `detection_enabled` toggle.
  - `backend/domain/episode.py` — one `Episode` per active incident (temporal dedupe + sustained-risk downgrade).
  - `backend/state.py` — thin module owning singletons (`STORE`, slot registry), nothing else.
  - `SettingsStore` owns config (§2.4).
- **Impact.** State changes go through typed methods, not ad-hoc dict mutation. Tests construct a fresh `StreamSlot` directly.
- **Alternatives.** Global module-level dicts (what we had); Redis/external KV (deploy complexity for a single-process edge); Pydantic models for state (validation cost on every write — state is hot, config is cold).

## 2.7 Privacy & security

### Plate hashing at ingest (not egress)
- **Problem.** License plate text is PII under GDPR. "Scrub at egress" is fragile — every new consumer must remember to strip.
- **Why it mattered.** A single forgotten `return event` leaks PII to a log or in-memory buffer.
- **Fix.** `enrich_event()` in `services/llm.py` hashes the plate and **strips `plate_text`/`plate_state` before** the event reaches any buffer. `perception/emit.py` keeps a defense-in-depth `pop()`, but the primary invariant — no raw plate in any buffer — is enforced at **ingest**. Encoded in `CLAUDE.md` + `.claude/rules/python.md`.
- **Impact.** The plate is read **once**, in a controlled LLM call, and nowhere else. A future buffer consumer **cannot** leak because the field doesn't exist.
- **Alternatives.** Egress scrub (convention-enforced; one miss = leak); KMS-encrypted at rest (per-event KMS call on hot path; plate still briefly cleartext in memory).

### SSRF guard + rate limit
- **Problem.** Operator-supplied URLs (adding a stream source) could point at internal services (`localhost:5432`, metadata IPs) — classic SSRF.
- **Fix.** `backend/security/ssrf.py::validate_public_url()` rejects private/loopback/link-local. `backend/security/rate_limit.py` caps per-IP clip renders.
- **Impact.** Operator (or attacker via UI) cannot make the edge fetch internal endpoints.

### Edge → cloud HMAC
- **Problem.** A cloud receiver accepting unsigned batches is a PII firehose for anyone guessing the URL.
- **Fix.** Every edge→cloud batch signed with HMAC over the payload. Receiver verifies before touching the payload, dedupes on `event_id` (retries safe).
- **Impact.** TLS proves you're talking to the right **server**; HMAC proves the batch was minted by an authorized **edge**. Works air-gapped with a shared secret — no IdP dependency.
- **Alternatives.** TLS alone (URL leak = anyone forges); OAuth client-credentials per edge (needs IdP reachable from every edge — incompatible with air-gap); managed broker (SQS/Kafka) — vendor-coupled, doesn't work on-prem.

## 2.8 Resilience — single LLM egress, failover, cost ceiling

- **Problem.** A perception system that calls Claude from five places is one outage away from being unable to start. No single place for a circuit breaker, cost cap, or retry policy.
- **Why it mattered.** Provider 529 "overloaded" → cascading failure across watchdog, enrichment, agents.
- **Fix.** All LLM calls route through `backend/services/llm.py` (~1,000 LoC). Nothing else imports an SDK (enforced by `.claude/rules/python.md`). Owns:
  - Provider selection — Anthropic + Azure OpenAI with automatic failover.
  - Per-minute + per-hour rate budget.
  - Circuit breaker on consecutive failures (3 fails → 60s open).
  - Cost tracking (`/api/llm/stats`).
  - Plate-hashing in `enrich_event` (privacy invariant).
  - "No-network" stub mode for tests.
- **Impact.** Anthropic 529 → watchdog still runs (rules-only branch, §2.9), enrichment falls back to secondary provider or skips, cost meter prevents runaway retry loop.
- **Alternatives.** Each consumer calls its own SDK (breaker state fragments, cost tracking impossible, privacy invariant reimplemented N times); LangChain / LlamaIndex (heavy dependency, opinionated chains); sidecar service (extra deploy, extra hop, re-opens plate-handling surface across processes).

## 2.9 Observability — watchdog as an incident queue

- **Problem.** "Error logs" get tuned out within a week. Operators need **what to do**, not **what happened**.
- **Why it mattered.** Alert fatigue = real bugs ignored.
- **Fix.** Watchdog findings carry `severity`, `category`, `impact`, `likely_cause`, `owner`, `evidence`, `investigation_steps`, `debug_commands`, `runbook`, `priority_score`, `source` (`rule` | `ai`), `cause_confidence`. Grouped by **fingerprint** — repeated symptoms collapse into one ticket. Two layers:
  - **Rules** (`rules.py`) — deterministic, always available.
  - **AI hypothesis** (`ai.py`, Claude) — strictly additive; deduplicated against rules (**rules win** on same fingerprint *or* title).
- **Design invariant:** monitoring **never** depends on the LLM. If Anthropic is unreachable, `ai_analyze` returns `[]` and rules carry on.
- **Impact.** Operators get "paste this `curl` to reproduce" instead of a log wall. Monitoring survives provider outages.
- **Alternatives.** Datadog / Sentry (mature UI but no perception-domain knowledge; needs outbound internet — incompatible with air-gap); rules only (misses novel patterns); LLM-first with rules as fallback (violates "must survive outages" invariant).

## 2.10 Critical bugfixes (BE)

1. **Hot-path config race** → `SettingsStore` snapshot isolation (atomic pointer swap).
2. **Lost-update on concurrent settings edits** → `If-Match: expected_revision_hash` → HTTP 409; per-token/IP 5-second apply cooldown; single-use 30-second SSE tickets.
3. **PII leak risk in event buffers** → plate hash at ingest + fields stripped.
4. **Cascading LLM outages** → circuit breaker + provider failover + rules-only watchdog fallback.
5. **Forged cloud ingest** → HMAC-signed batches + idempotent receiver (`INSERT OR IGNORE`).
6. **SSRF via stream URL input** → `validate_public_url()` guard.
7. **Inference CPU burn on idle tiles** → `StreamSlot.has_viewers`: encode only when watched.
8. **Real FPS/CPU telemetry** → `psutil`-backed ops sampler replaced ad-hoc estimates → feeds ImpactMonitor with real numbers.
9. **Watchdog loop blocked on LLM** → AI hypothesis moved async; rules-first.
10. **Subscriber crash poisoning apply chain** → each subscriber wrapped in `try/except`; errors counted but don't roll back the apply.

## 2.11 Best practices applied (BE)

- **Composition root.** `server.py` wires things; it doesn't contain logic.
- **One egress per concern.** All LLM calls via `services/llm.py`; all settings writes via `SettingsStore.apply_diff()`.
- **Immutable snapshots for hot-path config.** Readers never block writers; no partial reads.
- **Rules before AI.** Deterministic floor; AI additive and deduplicated.
- **Message auth, not just transport auth.** HMAC on the edge→cloud channel.
- **Defense in depth.** Plate-hash at ingest **and** a defensive `pop()` at egress.
- **Static typing on the boundary.** Wire contract is `mypy`-strict.
- **Pydantic models as single source of truth.** Codegen to TypeScript.
- **Atomic diffs with rollback.** `last_known_good` + pointer swap.
- **Document invariants.** `CLAUDE.md` + `.claude/rules/*.md` convert tribal knowledge to enforceable text.

## 2.12 Best judgments (what I chose *not* to do — BE)

- **No auth in the POC.** Half-built auth is worse than none (operators assume protection that isn't there). Gap documented in `README` + `CLAUDE.md`; HMAC and audit log still protect the channels that matter. Real auth belongs at the reverse proxy.
- **No full hexagonal architecture.** Would triple file count for a single-process POC with one perception backend.
- **No feature-flag SaaS (LaunchDarkly/Unleash).** Doesn't do statistical impact gating — the actual product differentiator.
- **No etcd/Consul for config.** Overkill for one process; SQLite for durable history is enough.
- **No OpenAPI-to-TS yet.** Needs `response_model=` on 100% of handlers first.
- **No full-codebase `mypy --strict`.** Typing `numpy`/`cv2` shapes is weeks of cleanup for marginal benefit.
- **Dashcam code fully stripped, not flag-gated.** Two products fighting in one repo produced contradictory gates. `dashcam-last-known-good` tag preserves the archaeology path.

---

# 3. Summary matrix — FE vs BE by area

| Area | Frontend fix | Backend fix |
| --- | --- | --- |
| Project structure | Feature folders + import rule | Feature packages under `backend/` |
| Giant files | `SettingsPage`, `MultiSourceGrid` decomposed | `server.py` 1535→189; `watchdog.py` split into package |
| Network | `apiFetch` + `HttpApiError` + `AbortSignal`; MJPEG/poll auto-switch | 15 routers + HMAC ingest + SSRF guard |
| State management | TanStack Query (server state) | `SettingsStore` snapshot isolation (hot-path config) |
| Hooks / lifecycle | Shared `useSSE`, single `EventStream` provider | `StreamSlot` viewer tracking |
| UI / reusable | `shared/ui/` primitives library | n/a |
| Type safety | Generated TS from Pydantic (`generated.ts`) | Two-tier `mypy` on API + LLM boundary |
| Performance | Lazy routes; background pause; optimistic UI | Encode-on-demand; lock-free config reads |
| Error handling | Per-route `ErrorBoundary`; `AbortSignal` | Circuit breaker; rules-only watchdog fallback |
| Privacy / security | n/a | Plate-hash at ingest; HMAC batches; SSRF guard |
| Observability | n/a | Watchdog fingerprinted findings (queue, not log) |

---

# 4. How I'd present this in an interview

1. **Open with the framework** — the matrix above. "These are the common areas I audit in any codebase."
2. **Pick two deep dives** that show judgment, not just work. I use:
   - **BE:** `SettingsStore` snapshot isolation — invariants (reader never blocks writer, writer never blocks readers, no partial reads).
   - **FE:** MJPEG vs polling auto-switch — the HTTP/1.1 6-connection cap and how HTTP/2 changes the math.
3. **Volunteer the gap.** "Auth is the biggest product-readiness gap — and here's why I didn't half-build it." Engineering judgment > feature enthusiasm.
4. **One alternative per topic.** "I considered X; rejected because Y." Proves I **chose**, didn't just **do**.

---

# 5. Honest gaps (short list)

- **Auth** — POC has no user auth by design. Documented; HMAC + audit log still in place for channels that matter.
- **Codegen drift-check in CI** — `make generate-types && git diff --exit-code` not yet wired.
- **No browser-level end-to-end smoke** (Playwright) — pytest + vitest cover the units; SSE + MJPEG path against a live `start.py` untested automatically.
- **No formal capacity benchmarks** — order-of-magnitude reasoning only.
- **`impact.py` (813 LoC) and `api/settings.py` (640 LoC)** — next file-level split candidates.
- **Single-instance `SettingsStore`** — one per edge process, no leader election yet.
- **JSONL stores grow unbounded** — rotation/compaction is implicit, not enforced.
