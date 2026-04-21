# Branch `refactoring_and_improvement` vs `main` — Interview Prep

**Scope:** 79 commits (≈2,700 file churn, most of it `node_modules` + generated `dist`). Meaningful source-code churn is roughly ±50k lines across backend and frontend.

**Headline:** This branch converts the repo from a single-file prototype (one 1,535-line `road_safety/server.py` + two static HTML pages) into a modular, feature-organized edge-perception app with a proper React SPA, a runtime Settings Console, multi-source live video, an incident-queue watchdog, a shadow-mode validator, typed APIs, and a documented POC-level security posture.

Reference documents for deep dives:
- `/Users/andreitekhtelev/Desktop/road-camera-safety-monitoring/docs/audit/backend.md` — backend audit (initial pass)
- `/Users/andreitekhtelev/Desktop/road-camera-safety-monitoring/docs/audit/frontend.md` — frontend audit (initial pass)
- `/Users/andreitekhtelev/Desktop/road-camera-safety-monitoring/docs/improvements/backend-audit-2026-04-20.md` — most recent backend audit (688 LoC)
- `/Users/andreitekhtelev/Desktop/road-camera-safety-monitoring/docs/improvements/frontend-audit-2026-04-20.md` — most recent frontend audit (712 LoC)
- `/Users/andreitekhtelev/Desktop/road-camera-safety-monitoring/docs/final/weekend-2026-04-18-to-20.md` — commit-by-commit rollup
- `/Users/andreitekhtelev/Desktop/road-camera-safety-monitoring/CLAUDE.md` — current architecture invariants

**Note on counts:** treat the LoC numbers below as scale indicators, not as a source of truth. This branch is still moving, and comment/docs churn changes exact counts faster than the architecture changes.

---

## 1. Architecture & project-structure refactor

**What changed.** The Python package was renamed `road_safety/` → `backend/` and split into proper subpackages: `backend/core/` (perception, orientation policy, validator, stream, depth, egomotion, quality, context), `backend/perception/` (hot path + emit + broadcast + slot control + risk/score_decay), `backend/services/` (LLM, drift, watchdog, impact, ops_sampler, templates, registry, redact, agents, llm_obs, digest, test_runner, settings_db), `backend/integrations/` (edge_publisher, slack), `backend/compliance/` (audit, retention), `backend/rendering/` (clip, frame, mjpeg), `backend/security/` (ssrf, rate_limit), `backend/api/` (routers + settings + feedback + models), plus `backend/state.py` (live-state singletons plus `Episode`, `StreamSlot`, and related domain instances), `backend/startup.py`, `backend/settings_store.py`, `backend/settings_spec.py`. The old monolithic `road_safety/server.py` shrank from 1,535 lines to `backend/server.py` at **189 lines** — purely a composition root that wires routers + lifespan.

**Why.** In the `main` baseline, `road_safety/server.py` is a 1,535-line monolith with 37 `@app.*` routes mixed with state/domain concerns; earlier internal snapshots had already drifted toward ~4,000 lines. In both shapes, routing, live state, and business logic were too tightly coupled, making review and unit testing painful and turning every feature into a same-file merge conflict. The rename `road_safety → backend` also clarifies layering: this process is the edge node; `cloud/` is a peer.

**Why it matters.** Each module is now independently testable and reviewable. New features (Settings Console, shadow validator, multi-source slots) landed as new files rather than 300-line diffs inside `server.py`. Onboarding time for a new engineer drops sharply — they can read `backend/server.py` in one screen and follow the imports.

**Possible next improvements.**
- ~~Introduce `mypy --strict` on `backend/api/` and `backend/services/llm.py` first~~ — **shipped** (see §18).
- ~~Replace the central `event: dict` contract with `pydantic.BaseModel` … and auto-generate TS types~~ — **shipped** (see §17). `frontend/src/shared/types/common.ts` is now a 50-line backward-compat shim re-exporting from the generated 462-line `generated.ts`.
- ~~Move `StreamSlot` + `Episode` out of `backend/state.py` into a dedicated `backend/domain/` package~~ — **shipped** (see §19). `backend/domain/episode.py` (190 LoC) and `backend/domain/stream_slot.py` (254 LoC) now own the per-source classes; `backend/state.py` dropped from 791 → 400 LoC and re-exports both names for backwards compat.
- Runtime test harness shapes are modeled as `TestResultModel` / `TestStatusModel` in `backend/api/models.py` and flow through §17 codegen; **still pending:** tightening any remaining dict-only responses on the tests router to those models everywhere.

**Alternative solutions & trade-offs.**
- **Alternative A: Keep monolithic `server.py`, split via in-file `APIRouter(prefix=...)` blocks.** *Pros:* one-file deploy artifact, no import-graph to reason about, smallest diff. *Cons:* still a merge-conflict magnet on every feature, routers can't be mounted into a test `FastAPI()` without dragging in the full lifespan + state globals.
- **Alternative B: Go full hexagonal / clean-architecture with `domain/`, `application/`, `infrastructure/` layers.** *Pros:* textbook perception-backend swappability, pure-domain unit tests. *Cons:* 3× the file count, ceremony tax on every endpoint, overkill for a single-process POC with one perception implementation.
- **Alternative C: Keep the `road_safety/` name and refactor in place.** *Pros:* zero churn for external tools (`tools/analyze.py`, Docker image tags, docs). *Cons:* `road_safety` vs `road-safety` hyphen confusion, reads poorly next to peer `cloud/`, misses the chance to signal "this is the edge node" via the name.
- **Verdict:** Feature-package split under `backend/` hits the sweet spot — testable units without hexagonal ceremony, and the rename clarifies the edge-vs-cloud peerage.

---

## 2. Backend API organisation — routers split

**What changed.** The route handlers that used to hang off `@app.*(...)` in monolithic `server.py` were extracted into **15 feature routers** under `backend/api/routers/` plus **two function-mounted routers** at `backend/api/` (with additional endpoints added as new features landed):

| Router | Responsibility | LoC |
| --- | --- | --- |
| `live.py` | Live status / events / clips | 344 |
| `sources.py` | Multi-source CRUD + start/pause/detection-toggle | 208 |
| `admin_health.py` | Admin health strip aggregator | 145 |
| `sse.py` | `/api/live/stream` SSE broadcaster | 130 |
| `watchdog.py` | Incident queue reads / deletes | 129 |
| `spa.py` | Static + SPA fallback | 110 |
| `agents.py` | Coaching / investigation / report agents | 101 |
| `admin_video.py` | MJPEG + single-shot frame endpoints | 94 |
| `road.py` | Road-level aggregations | 48 |
| `thumbnails.py` | Thumbnail serving | 46 |
| `active_learning.py` | Drift sampler feed | 40 |
| `tests.py` | Runtime test harness | 39 |
| `llm_obs.py` | LLM stats | 39 |
| `audit.py` | Audit log read | 37 |
| `retention.py` | Retention control | 28 |
| `__init__.py` (package) | Exports | 8 |

Two routers are *mounted via functions* because they need shared callbacks/state at registration time: `backend/api/feedback.py` (308 LoC) and `backend/api/settings.py` (640 LoC — large because it owns the impact-stream SSE and ticket exchange). Shared Pydantic response models live in `backend/api/models.py`.

**Why.** The route handlers in monolithic `server.py` shared little beyond the `app` singleton and were intermingled with business logic they called. Splitting them reduces cognitive load, lets routes be tested against a `TestClient` that mounts only the router under test, and makes it obvious where to add new endpoints.

**Why it matters.** Concretely demonstrable: `tests/test_settings_api.py` can `mount_settings_routes(fresh_app, ...)` in a fixture without booting perception or touching global state. That was impossible before. Also, code review is now per-router, not per-monolith.

**Possible next improvements.**
- Add `response_model=` on every handler (most already have it on the live/sources routes) — unlocks OpenAPI codegen (audit §1.2 Plan B).
- Add an API versioning prefix (`/api/v1/`) before this ships to anyone outside the team.
- Split `live.py` (344 LoC) once clip-download adds its own lifecycle.
- Decompose `backend/api/settings.py` (640 LoC) — the impact-stream SSE + ticket exchange has earned its own module.

**Alternative solutions & trade-offs.**
- **Alternative A: Group routers by HTTP verb / layer (reads vs. writes vs. streams) instead of by feature.** *Pros:* easy to apply cross-cutting concerns (auth on all writes, caching on all reads). *Cons:* a "live events" change now touches three files; feature ownership blurs; not how the frontend `features/` folders map.
- **Alternative B: One `APIRouter` per resource, collapsed into 4–5 big routers (`/live`, `/admin`, `/settings`, `/watchdog`).** *Pros:* fewer files, matches REST intuition. *Cons:* `live.py` would re-drift toward 800 LoC; `admin_video.py` + `admin_health.py` share nothing but the URL prefix.
- **Alternative C: Keep routes as functions, but use `fastapi-class`-style class-based controllers.** *Pros:* shared init for dependency-injected collaborators. *Cons:* non-idiomatic FastAPI, breaks the dependency-override pattern used in `tests/test_settings_api.py`, adds a DI layer we don't otherwise need.
- **Verdict:** Feature-sliced routers (15 in `routers/` + 2 function-mounted, 1 responsibility each) mirror the frontend `features/` folder exactly — one engineer owns both ends of a slice.

---

## 3. Settings Console + Impact Monitoring (major new feature)

**What changed.** Brand-new runtime configuration surface that lets an operator edit perception tunables (TARGET_FPS, gate thresholds, redaction policy, ALPR mode, validator settings, etc.) **without restarting the server** and see the resulting operational impact in near real time.

Key pieces:
- `backend/settings_spec.py` — single source of truth: `SCHEMA_VERSION`, `SettingSpec` metadata (type/range/enum/cross-field validators), mutability buckets (`hot_apply` / `warm_reload` / `restart_required` / `read_only`).
- `backend/settings_store.py` (398 LoC) — `SettingsStore` with atomic `apply_diff()`: validates via `settings_spec`, honours `If-Match` lost-update protection (`expected_revision_hash`), rebinds a frozen `MappingProxyType` snapshot under a short `RLock`, records `last_known_good` for rollback, fans out to subscribers each in its own `try/except`. Hot-path readers use `STORE.snapshot()` (lock-free, immutable view — readers never block the writer and the writer never blocks readers).
- `backend/api/settings.py` (640 LoC) — full router: `GET /api/settings/{effective, schema, baseline, impact, impact/history, apply_log, observability}`; `POST /api/settings/{validate, apply, rollback, baseline/capture, stream_ticket}`; SSE `GET /api/settings/impact/stream?ticket=…`. Includes a per-token/IP 5-second cooldown and single-use 30-second tickets for SSE.
- `backend/services/impact.py` (813 LoC) — baseline + after-window engine. Distinguishes **immediate** metrics (event-rate, severity ratios, scene/quality mix, confidence percentiles) from **lagging** metrics (drift precision, FP-rate-from-feedback; surfaced as `"awaiting feedback"` until enough verdicts accrue). Comparability is gated by minimum sample size, scene-mix Jensen-Shannon divergence, and quality-state similarity, emitting a `confidence_tier` ∈ `high | medium | low | insufficient`.
- `backend/services/ops_sampler.py` — `psutil`-backed FPS + CPU sampler feeding the ImpactMonitor.
- `backend/services/settings_db.py` — SQLite persistence for apply log + impact sessions (survives restart).
- `frontend/src/features/settings/` — full SPA feature: `SettingsPage.tsx`, `Tunable.tsx` (per-key edit widget with help popovers + `humanizeKey`), `TunablesColumn`, `ImpactCard` (last-updated timestamp + 5s polling), `OpsDeltas` (before/after FPS + CPU), `ApplyResultBanner`, `SeverityBars`, `LivePreviewCard`, `SettingsHeader`. Hooks: `useSettings`, `useSettingsApply`, `useImpact`. Utilities under `utils/` (`formatting`, `steps`, `validation`).

**Why.** Changing a detection threshold in YAML + restarting the edge node is a 60-second outage per tweak and gives zero feedback on whether the change helped. Operators in fleet-safety tune alert thresholds daily; every tune cycle without impact telemetry is a guess.

**Why it matters.** This is the flagship product differentiator: operators get a statistically-gated "your change caused event-rate to drop 18% with confidence=medium (scene mix unchanged)" instead of a shot in the dark. The comparability gates (sample-size floor, JSD scene drift, quality similarity) prevent the classic observability trap where a setting appears to improve precision but the scene mix just changed under it. The templates UI flow was deliberately trimmed back (see commits `0017dac`, `60e4f02`), while backend template endpoints/tests remained available — the team shipped the core apply+impact loop first rather than over-extending an unproven presets UX.

**Possible next improvements.**
- Per-tunable A/B mode (split traffic between old and new snapshot on the same edge) instead of one global apply.
- Multi-instance leader election (currently one in-memory singleton per edge process — plan §S2).
- Bring templates back with versioning once the single-knob flow is proven in the field.
- Lagging-metrics estimator: rather than "awaiting feedback", compute a Bayesian lower bound on precision as feedback accrues.

**Alternative solutions & trade-offs.**
- **Alternative A: YAML file + SIGHUP / file-watcher reload.** *Pros:* zero new code, git-tracked history, trivial to roll back with `git revert`. *Cons:* no validation feedback to the operator, no impact measurement, requires shell access on the edge node, no `If-Match` lost-update protection when two operators edit concurrently.
- **Alternative B: Feature-flag SaaS (LaunchDarkly, Unleash, Flagsmith).** *Pros:* audit log, user targeting, gradual rollout, RBAC all shipped. *Cons:* $$$ per seat, SaaS dependency on a device designed for air-gapped edges, doesn't model perception-tunable numeric ranges well, still no statistical impact gating (which is the actual product differentiator).
- **Alternative C: etcd / Consul KV + watcher goroutines.** *Pros:* battle-tested config distribution across a fleet of edges, leader election solved. *Cons:* you deploy an etcd cluster for a single-process POC, operator UX becomes "edit JSON in Consul UI", and again no impact engine.
- **Verdict:** Bespoke `SettingsStore` + `ImpactMonitor` because the differentiator is the JSD-gated statistical comparability — no off-the-shelf config system does that, and once you're writing that, folding config persistence into the same SQLite is a small marginal cost.

---

## 4. Live video transport — MJPEG vs polling auto-switch

**What changed.** The multi-source admin grid now auto-selects its video transport based on the page protocol:
- **HTTPS → MJPEG** (`GET /admin/video_feed/{id}`, `multipart/x-mixed-replace`) — server pushes each JPEG with no polling latency floor.
- **HTTP → polling** (`GET /admin/frame/{id}`, single JPEG every ~400 ms via `POLL_INTERVAL_MS.streamImageFrame`).

Override via Vite env `VITE_ROAD_VIDEO_TRANSPORT=mjpeg|poll`. Both endpoints stay live regardless — `/admin/frame/{id}` doubles as a one-shot snapshot source for tests.

Key files:
- `frontend/src/features/admin/components/StreamImage.tsx` — transport-selection + per-tile lifecycle.
- `backend/api/routers/admin_video.py` — both endpoints.
- `backend/rendering/mjpeg.py` — MJPEG encoder.
- `backend/rendering/frame.py` — single-frame encoder with auto-shedding policy.
- `backend/state.py::StreamSlot` — viewer-presence tracking: `mark_polled`, `has_viewers`, MJPEG subscriber count.

**Why.** Two technical constraints collide:
1. Browsers cap concurrent HTTP/1.1 connections at **6 per host**. With a persistent MJPEG connection per tile plus an SSE connection, four tiles already eat the budget and the fifth stalls.
2. Local dev uses uvicorn speaking HTTP/1.1 directly (no TLS), so MJPEG deadlocks past ~4 tiles.

HTTP/2 (which needs TLS to activate in browsers) multiplexes everything over one connection and dissolves the cap — so in production behind an HTTPS reverse proxy (nginx/Caddy/Cloudflare/ALB) MJPEG works fine. Auto-detection by `window.location.protocol === "https:"` means zero client config to switch.

**Why it matters.** (a) Developers can run 8 live tiles locally without changing any config — the auto-detect picks polling. (b) Production deployments behind HTTPS automatically get push-based MJPEG with no polling latency. (c) Pairing this with `StreamSlot.has_viewers` means idle tiles stop burning JPEG encode cycles — "encode only when someone is watching". (d) Per-slot `detection_enabled` lets ops drop inference load on quiet tiles without restarting the stream (commit `df478f2`).

**Possible next improvements.**
- WebRTC transport option for sub-100ms latency (MJPEG floor is one frame period + decode).
- Server-side adaptive JPEG quality based on bandwidth per subscriber.
- Client-side MJPEG decoder cap (partially present) — unit-test at 8/12/16 tiles.
- Generate pre-signed URLs for `/admin/video_feed` when auth is eventually added (signed-URL scaffolding already landed in commit `c1f1804`).

**Alternative solutions & trade-offs.**
- **Alternative A: WebRTC for every tile.** *Pros:* sub-100ms latency, adaptive bitrate, native browser decoding, NAT traversal solved. *Cons:* need STUN/TURN infrastructure and an SFU or one PeerConnection per tile, browser-version quirks, huge overkill for 2 fps inference output where a frame-period floor is invisible.
- **Alternative B: WebSocket + binary JPEG frames, one socket per tile (or multiplexed).** *Pros:* works on HTTP/1.1, flexible framing, no connection-cap issues if multiplexed. *Cons:* reimplements what `<img src=multipart/x-mixed-replace>` gives us for free — manual decode, manual backpressure, more client code, no built-in frame pacing.
- **Alternative C: HLS for all tiles.** *Pros:* CDN-cacheable, standard, works through every proxy. *Cons:* 6–10 s latency floor from segment packaging, kills the "live" feel operators expect, adds `ffmpeg` as a hot-path dependency for every source.
- **Verdict:** MJPEG on HTTPS/h2 is the simplest transport that still does push delivery; polling fallback makes local HTTP dev work without any infra, and both endpoints being live means tests and snapshots get a one-shot JPEG for free.

---

## 5. Watchdog — incident queue (not a log tail)

**What changed.** `backend/services/watchdog.py` started as a ~1,800-line monolith and has been split into a `backend/services/watchdog/` package with one concern per file:

| File | Responsibility | LoC |
| --- | --- | --- |
| `model.py` | `WatchdogFinding` dataclass + fingerprinting + defaults table + normalization + grouping + `make_finding` | 530 |
| `rules.py` | Deterministic rule-based detectors (`rule_checks`) — perception / drift / LLM / stream | 435 |
| `api.py` | `Watchdog` background loop + `stats()` aggregator surfaced to `/api/watchdog` | 183 |
| `storage.py` | Append-only JSONL writer/reader for `data/watchdog.jsonl` | 132 |
| `ai.py` | Claude hypothesis layer (`ai_analyze`) — strictly additive | 130 |
| `__init__.py` | Public surface + legacy `_rule_checks` / `_write_finding` aliases | 108 |

The package is explicitly designed as an incident queue, not a log wall. Repeated operational symptoms are grouped by `fingerprint` into findings carrying: `severity`, `category` (perception | drift | llm | stream | scene | system), `impact`, `likely_cause`, `owner`, `evidence` (structured label/value/threshold/status), `investigation_steps`, `debug_commands`, `runbook`, `priority_score`, `source` (`rule` | `ai`), `cause_confidence` (`observed` | `inferred`). Findings persist to `data/watchdog.jsonl`.

Two stacked analyzers: deterministic rule-based detectors in `rules.py` (always available) and an AI hypothesis layer in `ai.py` (Claude), deduped against rule output so **rules win** on the same fingerprint OR title. Design invariant: monitoring never depends on LLM availability — if the provider is unreachable, `ai_analyze` returns `[]` and the rule layer carries on alone.

Frontend `frontend/src/features/watchdog/` + `frontend/src/features/monitoring/`: `IncidentCard`, `IncidentFeed`, `SummaryGrid`, `SummaryHeader`, `MetaGrid`, `SelectionBar`, `ImmediateActions`, `WatchdogContext`.

**Why.** The old version was a log of errors. Operators tuned it out within a week. Grouping by fingerprint with "paste this `curl` to see the bug" cuts diagnosis time.

**Why it matters.** Demonstrates production-engineering maturity — the difference between "we send alerts" and "we tell you what to do about them". Also a textbook example of **rules-before-AI fallback** that survives provider outages.

**Possible next improvements.**
- Owner auto-suggestion from CODEOWNERS.
- SLO tracking: auto-open / auto-close an incident when the underlying metric recovers.
- Alertmanager/PagerDuty webhook for `severity=error` findings only.
- ~~Continue the decomposition already underway: `model.py` and `storage.py` have been extracted, but rules/AI/orchestration still dominate `backend/services/watchdog.py`~~ — **shipped.** The flat module is gone; rules, AI, and orchestration each live in their own file inside the `watchdog/` package (see table above).

**Alternative solutions & trade-offs.**
- **Alternative A: Ship logs to an APM (Datadog, Sentry, New Relic) and rely on their grouping.** *Pros:* mature UI, on-call integrations free, search / retention handled. *Cons:* per-event cost at fleet scale, no perception-domain knowledge (can't write "drift precision dropped below 0.8 for urban scenes"), needs outbound internet from edges — incompatible with air-gapped deployments.
- **Alternative B: Rules-only engine, no LLM hypothesis layer.** *Pros:* deterministic, zero LLM cost, no failure mode when Anthropic is down. *Cons:* misses novel symptom combinations, operators have to hand-write a detector for every new failure class; loses the "explain this" UX that turns noise into an incident ticket.
- **Alternative C: LLM-first analyzer with rules as fallback.** *Pros:* catches novel patterns without hand-authoring detectors. *Cons:* violates the invariant that monitoring must survive provider outages, inverts latency (LLM call per group), and produces non-reproducible incidents that are hard to test.
- **Verdict:** Rules-win-on-fingerprint layering gives deterministic floor + LLM-authored enrichment on top — monitoring never *depends* on the LLM, but benefits when it's available.

---

## 6. Privacy & compliance — plate hashing at ingest, dual thumbnails

**What changed.** The privacy invariant was hardened and **documented as an architecture rule**: `enrich_event()` in `backend/services/llm.py` hashes the plate (`_hash_and_strip_plate`) and strips `plate_text` / `plate_state` from the returned dict **before** it reaches any in-memory event buffer. `backend/perception/emit.py` keeps a defence-in-depth `pop()`, but the primary invariant — no raw plate text in any buffer — is enforced at ingest, not at egress. `services/redact.py::write_thumbnails` produces dual internal + `_public` thumbnails; shared channels only touch the public variant.

This is now called out in both `CLAUDE.md` (Privacy invariant section) and `.claude/rules/python.md` (hot-path rules), so any agent edit is blocked by convention.

**Why.** "Scrub at egress" is fragile — every new consumer must remember to strip. "Scrub at ingest" means a forgotten consumer **cannot** leak because the raw plate was never in memory to leak.

**Why it matters.** GDPR Art. 5 data-minimisation aligns with this pattern. Audit-ability: `backend/compliance/audit.py` records every sensitive access (actor/resource/outcome/IP). Cloud receiver (`cloud/receiver.py`) separately verifies HMAC on edge→cloud batches (message auth, not user auth). The compliance posture is disproportionately mature for a POC.

**Possible next improvements.**
- Third-party ALPR processor agreement when `ROAD_ALPR_MODE=third_party` is enabled — the plate does leave the edge in that mode; the README is careful about this.
- Automated privacy-regression test: property test that fuzzes `enrich_event` output and fails if `plate_text` ever appears.
- `SECURITY.md` with threat model + PII classification table.

**Alternative solutions & trade-offs.**
- **Alternative A: Scrub at egress only (strip `plate_text` in `emit_event`, SSE serializer, Slack payload).** *Pros:* central enrichment keeps full context for debugging, plate still available for LLM follow-ups. *Cons:* every new consumer has to remember to strip — the invariant is enforced by convention not structure, and one forgotten `return event` leaks PII to a log or memory snapshot.
- **Alternative B: Encrypt `plate_text` at-rest with a KMS key, decrypt only at authorized egress.** *Pros:* keeps the raw value recoverable under audit, aligns with "pseudonymisation" language in GDPR. *Cons:* KMS call per event on the hot path (latency + availability coupling), key-rotation story, and the plate is still briefly in cleartext memory — the leak surface doesn't shrink.
- **Alternative C: Delete plate fields before the LLM call (never read them at all).** *Pros:* maximally minimal. *Cons:* loses ALPR entirely — the whole point of `enrich_event` is that the LLM *does* read the plate crop, hash it, and return the hash; skipping the read breaks the feature.
- **Verdict:** Hash-at-ingest is the narrowest possible trust boundary — the LLM sees the plate exactly once in a controlled call, everything downstream only ever sees the hash, and the invariant is enforced structurally (the field doesn't exist in the buffer) rather than behaviorally.

---

## 7. Frontend architecture — feature folders, shared UI, TanStack Query

**What changed.** The frontend was rebuilt around a feature-first folder layout that the rules file now codifies as the target architecture:

```
frontend/src/
  app/
    router.tsx     ← lazy routes wrapped in <RouteShell> (ErrorBoundary + Suspense)
    providers.tsx  ← QueryClientProvider → BrowserRouter → WatchdogProvider → DialogProvider
  features/
    admin/         ← MultiSourceGrid, StreamImage, StreamTile, HealthStrip, AdminEventCard, ...
    dashboard/
    monitoring/    ← IncidentCard, IncidentFeed, SummaryGrid, ...
    settings/      ← SettingsPage, Tunable, ImpactCard, OpsDeltas, hooks/, utils/, api.ts
    tests/
    validation/    ← ValidationPage, EventsPanel, ValidatorControl
    watchdog/      ← WatchdogContext, WatchdogDrawer, api.ts
  shared/
    ui/            ← Button, Card, Dialog, EmptyState, ErrorBoundary, ErrorList,
                     EventFilterBar, Input, Pill, RiskBadge, Section, Skeleton,
                     Spinner, Tabs, Tag, Dot
    layout/        ← PageChrome, PageLayout, TopBar
    events/        ← EventCard, EventDialog, EventStreamProvider, FeedbackButtons
    hooks/         ← useSSE, useEventStream, useLiveStatus, useUptimeTicker
    lib/           ← fetchClient (apiFetch / HttpApiError / retry-after),
                     queryClient (staleTime 5s, refetchOnWindowFocus, retry:1),
                     format, cx
    config/        ← runtime.ts — single source of truth for all POLL_INTERVAL_MS,
                     SSE_BACKOFF, STALE_TIME_MS, LIMITS, THRESHOLDS
    types/         ← common.ts
```

**Import rule** (`.claude/rules/frontend.md`): the target rule is that a feature imports from `shared/` or itself — never from another feature. If two features need the same thing, promote to `shared/`.

Data flow:
- **TanStack Query** for every fetch; polling hooks wrap `useQuery` with `refetchInterval` (+ `refetchIntervalInBackground: false`), not hand-rolled `setInterval`. The legacy `shared/hooks/usePolling.ts` was **deleted** to make this enforceable.
- **One shared EventSource for the main safety-event feed**: `<EventStreamProvider>` in `providers.tsx`, consumed via `useEventStreamCtx()`. Separate specialized feeds (for example `/admin/detections`) still use dedicated hooks, so the stricter rule is "don't duplicate ownership of the same SSE stream."
- `fetchClient.ts` centralises `cache: "no-store"`, structured `HttpApiError` bodies (422 validation, 409 conflict, 429 with `Retry-After`), and Content-Type inference.
- **AbortSignal** threaded through `apiFetch` and every `useQuery` call (commit `7f2df1d`) so fetches cancel on unmount — no zombie state writes, no noisy error logs in StrictMode double-invoke.
- **Optimistic UI** with 8-second stuck-busy escape on live-source mutations (`286a492`, `742fa91`, `cc0e2e1`).
- **React Router lazy routes** — each page its own chunk; an error in one does not take out the others.

**Why.** The audit (`docs/audit/frontend.md`) called out the previous version: 431 lines in `SettingsPage.tsx`, 341 in `MultiSourceGrid.tsx`, hand-mirrored `common.ts` at 340 lines. Some of those hotspots have since been reduced materially, but the architectural goal remains the same: reduce cross-feature coupling, keep page files thin, and stop hand-rolling client-side data flow. TanStack Query replaces ad-hoc cache with a real cache + `invalidateQueries` invalidation protocol.

**Why it matters.** Review and test scopes map to feature folders — one engineer owns `features/settings/`, another `features/admin/`, and they don't touch each other's imports. Lazy routes mean `/settings` doesn't pay the cost of loading the watchdog bundle. Single `EventSource` means the server sees one subscriber per tab, not four.

**Possible next improvements.**
- ~~Replace hand-mirrored `shared/types/common.ts` (340 LoC) with codegen from Pydantic backend models~~ — **shipped** (see §17). `common.ts` is now a 50-line re-export shim around `generated.ts`.
- Enforce the "no cross-feature imports" rule for real: `settings/`, `dashboard/`, and `validation/` still reach into sibling features and should promote shared hooks/components into `shared/`.
- Keep `SettingsPage.tsx` thin and prevent regression — the page has been decomposed, but its dependencies still span multiple domains.
- Surface `HttpApiError.retryAfterSec` in a reusable toast component.

**Alternative solutions & trade-offs.**
- **Alternative A: Redux Toolkit + RTK Query instead of TanStack Query.** *Pros:* single store for client + server state, excellent devtools, first-class normalized cache. *Cons:* ceremony tax per slice, boilerplate for what are effectively read-through caches, larger bundle, `AbortSignal` / Suspense story is weaker than TanStack Query's.
- **Alternative B: SWR for fetching + Zustand for client state.** *Pros:* tiny, minimal API, works great for simple polling. *Cons:* no built-in mutation queue / optimistic rollback story as polished as TanStack's, less momentum — many of the patterns the settings console uses (`useMutation` + `onMutate` rollback) would be hand-rolled.
- **Alternative C: Next.js app-router with server components.** *Pros:* SSR, smaller client bundle, built-in routing. *Cons:* the app is a live operator dashboard — nothing to SSR because every page is authenticated and live-streaming; Vite SPA + lazy routes is a better fit and keeps the dev loop snappy.
- **Verdict:** TanStack Query + React Router lazy routes + feature folders matches the product (operator SPA with heavy SSE + polling) without paying for SSR or Redux ceremony; the import rule (`features/*` can't cross-import) gives ownership boundaries without an enforced architecture library.

---

## 8. Testing improvements

**What changed.** New test files:

| File | Purpose |
| --- | --- |
| `tests/test_settings_api.py` (366 LoC) | Router contract: 422 validation shape, 409 revision conflict, 429 apply-rate-limit, ticket exchange + single-use, template CRUD over HTTP, baseline/impact reads |
| `tests/test_settings_store.py` (159 LoC) | `SettingsStore.apply_diff` atomicity, If-Match protection, subscriber fan-out resilience, rollback |
| `tests/test_settings_impact.py` (139 LoC) | Baseline + after-window stats, comparability gates (sample size, JSD, quality similarity), confidence tiers |
| `tests/test_settings_templates.py` (111 LoC) | Template CRUD + revisions (present even though the templates UI was trimmed) |
| `tests/test_orientation_policy.py` (444 LoC) | Per-orientation gate policy — SAE J3063 dispatch across N/S/E/W camera angles |
| `tests/test_validator.py` (196 LoC) | Shadow validator comparator: FP / FN / classification-mismatch; IoU helper |
| `tests/fe/smoke.test.ts` + `useSettingsApply.test.ts` + `verdict.test.ts` | Frontend unit tests alongside `tests/be/README.md` + `tests/fe/` split |

Existing tests were refactored for the new module layout: `test_api.py`, `test_compliance.py`, `test_config.py`, `test_core.py`, `test_integrations.py`, `test_security.py`, `test_services.py` all adapted to import from `backend/`.

**Why.** The old tests bound to `road_safety.server` imports and the single-threaded monolith. New features (validator, settings console, orientation policy) are substantial and need unit tests that don't boot perception.

**Why it matters.** `tests/test_settings_api.py` mounts a fresh `FastAPI` + fresh `SettingsStore` per test — true isolation. The test suite can now be run in parallel without shared-state flakiness. `tests/test_orientation_policy.py` at 444 LoC is the largest — reflects how much business logic the orientation dispatcher owns.

**Possible next improvements.**
- Property-based tests on `enrich_event` for plate-scrub (Hypothesis). One integration test currently asserts scrub; a property test would catch refactor regressions.
- Coverage gate in CI (`pytest --cov=backend --cov-fail-under=70`).
- Contract tests between the settings router and `frontend/src/features/settings/api.ts`.

**Alternative solutions & trade-offs.**
- **Alternative A: End-to-end Playwright tests driving the whole browser against a live `start.py`.** *Pros:* catches real integration bugs, covers SSE and MJPEG transport paths. *Cons:* 10× runtime, flaky on CI without careful waits, needs a GPU-less YOLO stub, slower feedback loop when you want to iterate on a gate threshold.
- **Alternative B: Full integration tests that boot the whole FastAPI app and perception pipeline per test.** *Pros:* "tests the real thing". *Cons:* 30 s per test from model load, shared global state (`state.py` singletons) causes order-dependency, can't run in parallel, defeats the per-router isolation the refactor enabled.
- **Alternative C: Snapshot-test the API response shapes only.** *Pros:* cheap to write, catches accidental schema drift. *Cons:* snapshot rot (every intentional change requires a re-record, people stop reading diffs), doesn't verify behavior — a buggy handler with a consistent response passes.
- **Verdict:** Pytest unit tests on routers (fresh `FastAPI` + fresh store per test) + `test_core.py` gate-integrity tests gives the right pyramid — fast feedback, true isolation, and the `test_orientation_policy.py` scale proves the pattern carries real business logic.

---

## 9. CI / developer experience — `.claude/` hooks, skills, rules, Makefile, lint

**What changed.**
- `.claude/hooks/hooks.json` + `check-edit.sh` — PostToolUse hook: every `Edit`/`Write` on a `.py` file runs `py_compile` (using `.venv/bin/python` if present) as a cheap syntax check. Non-blocking (`exit 0` always), async, 15-second timeout.
- `.claude/rules/python.md` — explicit conventions: `Path(__file__).parent` banned, logging conventions, async rules, hot-path gate rule, plate-scrub rule.
- `.claude/rules/frontend.md` — stack (React 19 / Vite / TS / react-router / TanStack Query), feature-folder layout, SSE ownership rule, import rule, build and type-check commands.
- `.claude/skills/{lint-code, test-suite, deploy}/SKILL.md` — project-specific skill definitions.
- `.claude/settings.json` + `.claude/settings.local.json` — tool allowlists, env, developer utility Bash commands.
- `Makefile` with `make test`, `make lint` (`py_compile` on `backend/server.py`, `backend/config.py`, `start.py`), `make typecheck` (**`pyright`**, using `[tool.pyright]` in `pyproject.toml` — not the same as narrow `mypy`; see §18), `make docker-up`, `make docker-up-cloud`.
- `start.py` — one-command launcher: builds frontend → runs pytest → boots uvicorn → waits for `/api/live/status` → opens browser. Flags: `--skip-tests`, `--cloud`, `--no-browser`, `--port`. Prefers `.venv/bin/python` over the system interpreter.
- New `.github/` CI workflows for frontend type-check (commit `d959872`).

**Why.** Two goals: (a) make contribution frictionless (one command from clone to running UI) and (b) make AI-assisted edits safe (hook blocks a Python edit that doesn't even compile).

**Why it matters.** The `py_compile` hook catches 80% of accidental import / syntax breaks in under a second. The skills let `/lint-code` and `/test-suite` reuse the project's exact commands instead of guessing. `.claude/rules/*.md` convert tribal knowledge (never call LLM outside `services/llm.py`, don't duplicate ownership of the same SSE stream, never add a 6th tool to an agent) into enforceable text.

**Possible next improvements.**
- Wire **narrow `mypy`** (see §18) or codegen drift-check into CI — `make typecheck` is already pyright; extend hooks or add `make mypy` / `make types` as explicit targets.
- Pre-commit: run `pytest tests/test_core.py` before merge to main (the gate-integrity suite).
- CI coverage upload + PR comment.
- Production `docker-compose.prod.yml` with nginx HTTP/2 fronting uvicorn (required at ≥6 streams per `CLAUDE.md`).

**Alternative solutions & trade-offs.**
- **Alternative A: Heavy pre-commit hooks (`black`, `ruff`, `mypy --strict`, `eslint --max-warnings 0`).** *Pros:* consistent style, catches more at commit time. *Cons:* 30 s+ per commit on a tired laptop, devs run `--no-verify` out of frustration, and the project hasn't agreed on a formatter yet — wiring one in now would burn goodwill before the payoff lands.
- **Alternative B: GitHub Actions running the full test + lint + build matrix on every push.** *Pros:* authoritative gate, visible PR status. *Cons:* 5–10 min feedback loop, costs compute minutes, still doesn't help AI agents mid-edit (they see the fail after the PR); the `py_compile` PostToolUse hook gives feedback in <1 s during the edit itself.
- **Alternative C: Adopt `nx` / `turborepo` to orchestrate frontend + backend + tests.** *Pros:* cached incremental builds, nice DX for monorepos. *Cons:* heavy tool for a two-package repo, adds a mental model to learn on top of the existing `Makefile`/`start.py` workflow.
- **Verdict:** `.claude/hooks` + `Makefile` + `start.py` gives sub-second agent feedback, one-command launch, and cheap manual lint — scale up to CI + formatter when the team grows past two engineers.

---

## 10. Access control — POC "open by default", documented honestly

**What changed.** Commits `4c39a38` and `891de4c` clarified: this POC has **no user accounts, no roles, no request authentication**. Every JSON route, SSE stream, and live-media endpoint is fully open. The prior branch flirted with an admin-bearer token for the Settings Console and a "shared authentication helpers" module (`586ad63`); the team pulled that back.

What remains:
- `backend/compliance/audit.py` still logs every sensitive access (actor/resource/outcome/IP) — forensic trail.
- `backend/security/ssrf.py` — `validate_public_url()` on any operator-supplied URL (e.g. adding a stream source).
- `backend/security/rate_limit.py` — per-IP clip-render rate limiter.
- Cloud receiver still verifies HMAC signatures on every batch (message authentication).
- `CLAUDE.md` carries a conspicuous "Do not expose this build to the public internet" notice.

**Why.** Half-built auth is worse than no auth — operators assume it protects things, and it doesn't. Rather than ship a bearer-token gate that can be trivially sniffed over plain HTTP, the team documented the gap and left security behind the reverse proxy where it belongs in production.

**Why it matters.** Shows product maturity: knowing when *not* to build something. The README and CLAUDE.md both flag the missing auth layer loudly. HMAC-on-ingest (edge → cloud) is still intact — that's message authentication, which solves a real threat (cloud receiver accepting forged batches from anyone with the URL).

**Possible next improvements.**
- OIDC/SAML integration via Cloudflare Access or AWS ALB OIDC before any real deployment.
- Per-route authorization (not just authentication) — driver safety-score endpoints need actor scoping for GDPR.
- Signed cookies on `/admin/video_feed` — scaffolding was added in `c1f1804` but not wired as a requirement.
- CSRF guard on mutating endpoints once cookies are in play.

**Alternative solutions & trade-offs.**
- **Alternative A: Ship a static admin-bearer token (like the earlier `586ad63` attempt).** *Pros:* one-line curl for scripted ops, trivial to deploy. *Cons:* sniffable over plain HTTP dev, no rotation story, no per-actor audit attribution, creates false confidence ("we have auth") while offering almost nothing.
- **Alternative B: Mutual-TLS between the operator browser and the edge.** *Pros:* strong identity, no passwords. *Cons:* cert-distribution UX on operator laptops is brutal, nothing for mobile-support access, and the edge has no PKI story yet.
- **Alternative C: OIDC via Auth0 / Cognito baked into the FastAPI app.** *Pros:* real auth, social login, MFA. *Cons:* couples the edge process to an SSO vendor, doesn't work air-gapped, and most fleet customers already have IdP at the reverse-proxy layer — re-implementing it in-app duplicates infra.
- **Verdict:** Document the gap loudly, keep HMAC on the edge→cloud ingest (message auth that *does* protect a real threat), and push user auth to the reverse proxy where it belongs in production — the audit log still attributes access for forensics.

---

## 11. Documentation

**What changed.**
- `CLAUDE.md` at the repo root — architecture invariants, hot path gate order, privacy invariant, LLM-layer rules, package layout, live-video transport rules, fleet identity, the codegen invariant ("change a wire shape only by editing `backend/api/models.py` and re-running `scripts/generate_ts_types.py`"), the narrow **`mypy`** scope in `pyproject.toml`, and "things to avoid" (anti-patterns list).
- `docs/architecture.md` — full system diagram + bandwidth math; where updated, contract-flow notes (Pydantic → JSON Schema → `generated.ts` → feature imports).
- `docs/challenges.md` — vendor-competitor context (Netradyne / Lytx / GoMotive) + which hard problems this solves.
- `docs/audit/backend.md` + `docs/audit/frontend.md` + `docs/audit/plan-a-pragmatic.md` + `plan-b-architectural.md` — full internal audit with options / trade-offs / recommendations per finding.
- `docs/improvements/*.md` — backend / frontend / integration execution plans + code-review notes + production-scale plan.
- `docs/final/weekend-2026-04-18-to-20.md` — the commit-by-commit rollup used to generate this doc.
- `docs/requirements/` — original scope.
- Four separate settings-console plans (claude code, codex, cursor, v1.0) — planning exercise across different AI tools.

**Why.** This project carries a lot of non-obvious "why this way" decisions — plate-scrub-at-ingest, 5-tool agent cap, multi-gate TTC, MJPEG-vs-poll. Without written rules, every new contributor re-litigates them.

**Why it matters.** `CLAUDE.md` is the "agent contract" — it turns the codebase into something an AI coding agent can edit safely without breaking the privacy invariant or adding an LLM call outside `services/llm.py`. The audit docs are review-ready artifacts that can go to an acquirer's engineering diligence process as-is.

**Possible next improvements.**
- `ADR/` directory with one entry per architecture decision (`001-plate-scrub-at-ingest.md`, `002-mjpeg-vs-poll.md`, etc.).
- Auto-generated API reference from OpenAPI once `response_model=` coverage hits 100%.
- A public `ARCHITECTURE.md` that imports from the internal audit docs but strips vendor comparisons.

**Alternative solutions & trade-offs.**
- **Alternative A: Keep all docs in a Notion / Confluence workspace.** *Pros:* collaborative editing, search, diagrams. *Cons:* drifts from code (no PR diff to review), access-controlled away from the agent, and `CLAUDE.md` specifically has to live next to the code to function as an agent contract.
- **Alternative B: Inline all architecture notes as Python docstrings + a `mkdocs` site.** *Pros:* colocation, auto-rendered reference. *Cons:* architecture rules are cross-cutting and don't belong on any one symbol; `mkdocs` is another build step to maintain; agents don't read generated sites, they read markdown files by path.
- **Alternative C: Pure ADR format from day one (no `CLAUDE.md`, no audit docs, just `ADR/001-...md`).** *Pros:* textbook, searchable, decision-focused. *Cons:* doesn't double as an agent contract (ADRs record *decisions*, not *invariants to enforce*), and the audit docs serve a distinct "diligence-ready" audience that ADRs wouldn't.
- **Verdict:** Split the audience — `CLAUDE.md` for agents, `docs/audit/*` for reviewers, `docs/architecture.md` for newcomers. ADR directory is a good next step but wasn't worth blocking on during the rebuild.

---

## 12. Removed features — dashcam stripped, this is road-cameras only

**What changed.** Commit `e37feef` (title: "Strip dashcam features: this project is road-cameras only") removed in-cab features: DMS (driver-monitoring), cabin feeds, vehicle-facing view, dashcam-file GPS-track auto-sync (some remnants kept for test fixtures as `dashcam_file` stream type). Commit `6bff79e` removed the "Live · YouTube" badge on stream tiles. Commits `2a1ff91`, `015d22b`, `31c499e` cleaned up obsolete files: deprecated audit logs, watchdog logs, settings.db / -shm / -wal artifacts, frontend package lock duplicates, old binaries. Commit `f4c2125` ("Refactor road safety system for fixed camera deployment") re-scoped the product to **fixed road-site cameras** (YouTube live feeds of intersections).

**Why.** Two products were fighting in one codebase: a vehicle-mounted dashcam product (vehicle_id attribution, in-cab feed, GPS sync) and a fixed-camera road-site product (intersection-level aggregation, per-angle orientation policy, no GPS). The second product won — the README now opens with "Real-time road-conflict detection for fleet dashcams" but the code and tests focus on fixed-camera deployments.

**Why it matters.** Product clarity: one thing done well. The new `backend/core/orientation_policy.py` (which dispatches events through SAE J3063 event families per camera orientation — N/S/E/W) is only coherent in a fixed-camera world. Trying to keep dashcam attribution + orientation policy together produced contradictory gate behaviour.

**Possible next improvements.**
- README should state the fixed-camera scoping more prominently (currently the opening line still mentions dashcams).
- Keep `stream_type == "dashcam_file"` alive as a named local-file loopback test fixture, but rename it (`local_file_loop`) to stop confusing readers.
- Separate the abandoned vehicle-mounted code into a tagged `dashcam-last-known-good` branch for archaeology.

**Alternative solutions & trade-offs.**
- **Alternative A: Keep dashcam + road-camera in one codebase behind a `DEPLOYMENT_MODE` env flag.** *Pros:* one artifact, broader market reach, no code deletion regret. *Cons:* every gate has a branch (`if mode == "dashcam": ...`), orientation policy is incoherent for a moving camera, tests double, and the in-cab / DMS privacy story is *totally different* from fixed-camera PII.
- **Alternative B: Fork into two repos (`dashcam-safety` and `road-camera-safety`).** *Pros:* each product gets a clean lineage, full independence of release cadence. *Cons:* shared perception code drifts, fixes have to land twice, two CI pipelines to maintain for a team of ~1.
- **Alternative C: Keep dashcam code as a dormant `backend/dashcam/` package behind a feature flag.** *Pros:* easy to resurrect, git history stays linear. *Cons:* dead code rots, contributors can't tell what's live, confuses the audit surface (is this in scope for security review or not?).
- **Verdict:** Full strip with a `dashcam-last-known-good` tag planned — one product done well, and git tags give the archaeology path back for free if strategy flips.

---

## 13. LLM resilience layer — single egress, multi-provider failover, cost ceiling

**What changed.** Every LLM call in the app routes through `backend/services/llm.py` (1,008 LoC). Nothing else may import an SDK. The module owns: provider selection (Anthropic and Azure OpenAI with automatic failover; Azure wins when both are configured), per-minute and per-hour rate budget, circuit breaker on consecutive failures, structured cost tracking (`/api/llm/stats` via `backend/api/routers/llm_obs.py`), retry with backoff, plate-hashing in `enrich_event` (see §6), and a "no-network" stub mode for tests. Observability is exposed through `backend/services/llm_obs.py` and surfaced in the watchdog's `category=llm` findings.

**Why.** A perception edge that "calls Claude" five places is one outage away from being unable to start. Centralising the call gives one place to put the breaker, one place to count tokens, one place to enforce the privacy invariant.

**Why it matters.** When Anthropic returns 529 "overloaded" the system degrades gracefully — watchdog still runs (rules-only branch, see §5), enrichment falls back to the secondary provider or skips, and the cost meter prevents a runaway loop from burning the monthly budget on retries. The architecture invariant ("no LLM imports outside `services/llm.py`") is enforced in `.claude/rules/python.md`.

**Possible next improvements.**
- Streaming token interface for the Copilot panel rather than wait-for-complete.
- Per-tenant cost ceilings once multi-tenancy lands.
- Local fallback model (Phi/Llama) for the enrichment path so the edge can keep classifying when both cloud providers are down.
- Promote the breaker state to a Prometheus gauge, not just a watchdog finding.

**Alternative solutions & trade-offs.**
- **Alternative A: Let each consumer call its preferred SDK directly.** *Pros:* zero abstraction, easy to swap models per call site. *Cons:* breaker state fragments, cost tracking impossible, privacy invariant must be re-enforced N times, and a provider outage cascades through every feature.
- **Alternative B: Use LangChain / LlamaIndex / Haystack.** *Pros:* batteries-included tracing, retries, prompt templates, evals. *Cons:* heavy dependency for a single-process edge, opinionated chains we don't need, and the failover/cost story is still ours to wire.
- **Alternative C: Push LLM calls out to a separate sidecar service.** *Pros:* clean process isolation, language-agnostic, restart without touching perception. *Cons:* +1 deploy artifact, +1 network hop on the hot path of enrichment, cross-process plate-handling re-opens the privacy surface we closed by hashing in-process.
- **Verdict:** One in-process module with a hard architecture rule. The breaker, the cost ceiling, and the plate-hash all live exactly once, and nothing at the edge needs an extra container to keep "what does our LLM cost this hour?" answerable.

---

## 14. Edge ↔ cloud ingest — HMAC-signed batches, idempotent receiver

**What changed.** The product is intentionally split into two peers: the **edge** (`backend/`, this process, runs perception + serves operators) and the **cloud receiver** (`cloud/receiver.py`, 484 LoC). The edge publisher (`backend/integrations/edge_publisher.py`, 774 LoC) batches public-thumbnail events, signs each batch with an HMAC over the payload, and POSTs to the receiver. The receiver verifies the HMAC before doing anything with the payload and dedupes by event id.

**Why.** A receiver that accepts unsigned batches from any caller is a free PII firehose for anyone who guesses the URL. Application-level message authentication is the right fix — TLS only proves you're talking to the right *server*, HMAC proves the batch was minted by an authorized *edge*.

**Why it matters.** This is "message auth, not user auth" — orthogonal to the missing user-auth gap discussed in §10. Even with operator UI fully open during the POC, the edge → cloud channel is structurally protected. The receiver is also idempotent: a network retry replays a batch, the receiver sees the same event ids and drops the duplicates. Public thumbnails (the `_public` variant from §6) are the only image data crossing the boundary; the internal-quality original never leaves the edge.

**Possible next improvements.**
- Rotate HMAC keys on a schedule with a grace-window verifier that accepts both old + new during rollover.
- Replay-window timestamp in the signed payload to prevent capture-and-resend.
- mTLS in addition to HMAC for defence in depth, once the deployment story includes a private CA.
- A receiver-side rate cap per edge id so a misbehaving edge can't flood the cloud.

**Alternative solutions & trade-offs.**
- **Alternative A: Trust the network — TLS-only, no HMAC.** *Pros:* simpler, one fewer secret to manage. *Cons:* anyone who learns the URL can POST forged events; TLS only protects the wire, not the origin.
- **Alternative B: OAuth client-credentials per edge.** *Pros:* standard, revocation built in, integrates with an SSO. *Cons:* requires an IdP available to every edge (incompatible with air-gapped sites), token refresh on the hot path adds failure modes, and the receiver still has to do the work to verify.
- **Alternative C: Push events through a managed broker (SQS / Kafka / EventBridge) with IAM auth.** *Pros:* durable buffer, replay built in, scaling solved. *Cons:* couples the edge to a specific cloud's IAM model, doesn't work for on-prem fleet customers, and message ordering / dedupe semantics still need application-level handling.
- **Verdict:** HMAC-signed batches keep the receiver provider-agnostic, work air-gapped if the edge is allowed any outbound HTTPS, and put the trust boundary in exactly one well-tested place.

---

## 15. Concurrency model of `SettingsStore` (deep dive)

**What changed.** `backend/settings_store.py` (398 LoC) is the only mutable global the hot path reads from. Its concurrency contract is simple and unusual:

- Writers take a short `RLock`, validate the diff, build a *new* immutable `MappingProxyType` snapshot, rebind the module-level reference atomically, and release the lock.
- Hot-path readers call `STORE.snapshot()` which returns the current immutable view *with no lock*. A reader holds whatever snapshot was current at call time even if a write completes mid-handler — the old snapshot stays alive until its last reference drops.
- Subscribers are notified outside the lock. Each subscriber callback runs in its own `try/except` so a buggy listener can't poison the apply chain.
- `last_known_good` is captured before each successful apply so `POST /api/settings/rollback` is a pointer swap, not a re-validate.

**Why.** The hot path runs at TARGET_FPS per source. Taking a lock per gate evaluation would burn measurable CPU on contention even in the no-write common case. Immutable snapshots + atomic pointer swap is the standard answer.

**Why it matters.** This is the textbook "snapshot isolation for config" pattern, and it's exactly the kind of thing senior reviewers probe. The invariants worth stating out loud:

- A reader **never** blocks the writer.
- A writer **never** blocks readers.
- A reader **never** sees a partially-applied diff (it sees either the old whole snapshot or the new whole snapshot).
- A subscriber failure **never** rolls back the apply (it is captured as an apply warning and increments the subscriber-error counter).

**Possible next improvements.**
- Per-key versioning so a subscriber can decide "I only care about TARGET_FPS changes" without re-diffing.
- Snapshot id in every emitted event (already partially present in the apply log) so an observer can correlate "which config produced this finding".

**Alternative solutions & trade-offs.**
- **Alternative A: Mutex per read.** *Pros:* simplest mental model, always fresh. *Cons:* hot-path contention scales with source count, no tear-free "old vs new" boundary in the audit log.
- **Alternative B: Copy-on-write `dict` with a single writer thread queue.** *Pros:* serialises writes naturally. *Cons:* still allocates a new dict per apply (we already do via `MappingProxyType`), and adds queue latency without removing reader-side work.
- **Alternative C: Persist to SQLite and re-read per access.** *Pros:* no in-memory state to manage, recovery is free. *Cons:* a SQLite hit per gate evaluation is the wrong order of magnitude (microseconds vs nanoseconds) and reintroduces the partial-read window.
- **Verdict:** Atomic-rebind + immutable snapshot — readers are lock-free, writers serialise on a short critical section, and the SQLite layer (`settings_db.py`) only owns *durable history*, not hot-path state.

---

## 16. Capacity envelope (rough numbers, not benchmarks)

**What changed.** No formal benchmarks landed on this branch, but the capacity story is worth being able to tell back-of-envelope in an interview.

| Dimension | Order-of-magnitude rule | Source / why |
| --- | --- | --- |
| Tiles per edge before browser cap bites | **~4 over HTTP/1.1**, **dozens over HTTP/2** | Browsers cap concurrent HTTP/1.1 connections at 6 per host; MJPEG holds one each (§4). |
| Inference cadence per source | TARGET_FPS, default ~2 fps | `backend/settings_spec.py` default; tunable hot-apply via Settings Console. |
| JPEG encode | Skipped when `StreamSlot.has_viewers == False` | "Encode only when someone is watching" (§4). |
| Settings apply latency | Sub-millisecond pointer swap; SQLite write off the hot path | §15 concurrency model. |
| LLM call budget | Per-minute + per-hour caps in `services/llm.py` | §13. |
| Cloud batch size | Tunable; receiver dedupes on event id | §14. |
| Watchdog overhead | Rule analyzers run on a timer, not per-event; AI hypothesis layer is async | §5. |

**Why this matters in an interview.** "How many cameras can one edge handle?" is a guaranteed question. The honest answer is "depends on resolution and inference model, but the architecture is bounded by HTTP/2 and TARGET_FPS, not by Python — we encode-on-demand and we don't lock the hot path on config reads." That answer is much more useful than a fake number.

**Possible next improvements.**
- Actual benchmarks: pick a reference resolution + GPU + tile count, publish numbers in `docs/architecture.md`.
- Continuous capacity probing: a synthetic load source in tests that asserts FPS holds at N tiles.
- Per-source admission control: refuse to add an N+1th source if FPS budget is exhausted, instead of degrading silently.

---

## 17. Type contracts — pydantic → generated TS, single source of truth

**What changed.** The hand-maintained `frontend/src/shared/types/common.ts` (previously 334 LoC of "trust me, the backend really does emit this shape") was replaced with a generated artefact:

- **`backend/api/models.py`** — all wire-shape Pydantic models live here. This branch added `EnrichmentModel`, `DetectionObjectModel`, `DetectionSnapshotModel`, `DriftReportModel`, `SceneThresholdsModel`, `PerceptionStateMessage` (discriminated-union variant of the perception SSE envelope, `_meta: "perception_state"`), the watchdog family (`WatchdogEvidenceModel`, `WatchdogFindingModel`, `WatchdogTopIncidentModel`, `WatchdogStatusModel`), and test-harness models (`TestResultModel`, `TestStatusModel`, wrapping the runtime tests payload) to fill out the previously untyped payloads. `risk_level` / `stream_type` are now `Literal` unions so the generated TS is a string-literal union rather than `string`. `bbox` is declared as a fixed-length `tuple[float, float, float, float]` so the emitted TS is a 4-tuple (safe to index under `noUncheckedIndexedAccess`). `models.py` exports an explicit `EXPORTED_MODELS` tuple that the codegen walks.
- **`scripts/generate_ts_types.py`** — walks `EXPORTED_MODELS`, asks each model for its JSON Schema, and converts the schema to TypeScript declarations in `frontend/src/shared/types/generated.ts` (462 LoC, machine-written). The walker is intentionally in-tree (no npm dep): it preserves Pydantic docstrings as JSDoc, collapses nullable-optional `field: X | None = None` to the `field?: X` FE convention, renders `prefixItems` as TS tuples, and renames `EventModel → SafetyEvent` / `SourceStatusModel → LiveSourceStatus` / etc. via a central override map.
- **`frontend/src/shared/types/common.ts`** — now a **50-line backward-compat shim** that simply `export type { ... } from "./generated"`. Every existing `import { Enrichment } from "shared/types/common"` keeps working untouched.
- **`start.py::regenerate_ts_types()`** — runs codegen *before* the Vite build, so a backend model change can never ship without the matching TS update. Failure is loud **and launch-blocking**: if generation exits non-zero, `start.py` aborts before building the frontend against stale types.

**Why.** The old `common.ts` was a refactor trap: any backend rename or field addition silently desynced from the frontend until a runtime parse error in StrictMode dev. "Source of truth in two places" is not a source of truth.

**Why it matters.** The wire contract is now physically generated from the Pydantic models. A field rename in `backend/api/models.py::DetectionSnapshotModel` produces a TypeScript type error at the next `start.py` (or `npm run build`), not a runtime mystery. The `_public` thumbnails / plate-hash invariants from §6 are now *expressible* in the type system because the generator follows model boundaries.

**Possible next improvements.**
- Hash-pin `generated.ts` in CI (`make generate-types && git diff --exit-code`) to fail builds where someone forgot to regenerate.
- Generate a Python-side `__schema_hash__` constant alongside the TS so we can detect contract drift in tests, not just at build.
- ~~Promote codegen from `start.py` into a Makefile target~~ — **shipped** as `make generate-types`; CI can call it independently of the launcher.
- Once the generator is exercised in CI, retire the `common.ts` shim and have features import from `shared/types/generated` directly.

**Alternative solutions & trade-offs.**
- **Alternative A: Adopt OpenAPI codegen (`openapi-typescript` against FastAPI's `/openapi.json`).** *Pros:* zero custom script, well-trodden tooling, also generates a typed client. *Cons:* requires `response_model=` discipline on every handler (we're at partial coverage — see §2 next-improvements), couples the type pipeline to running the FastAPI app, and the generated client has its own opinions about errors that fight with `HttpApiError`.
- **Alternative B: Hand-write TS types and lint with a contract-test suite.** *Pros:* no extra build step, types are human-readable. *Cons:* exactly the regime we just left — lint catches *some* drift, not all of it, and the test suite becomes a second source of truth that itself drifts.
- **Alternative C: Use `pydantic2ts` or `datamodel-code-generator` directly.** *Pros:* off-the-shelf, maintained, supports unions/discriminators well. *Cons:* one more transitive dep tree on a script that runs in 60 lines of project code; the bespoke generator gives us full control of the file header, the TS export style (`export type`, `verbatimModuleSyntax`-friendly), and the `__all__` filtering.
- **Verdict:** Bespoke generator + Pydantic models in `backend/api/models.py` — the pipeline is in our repo, runs in `start.py`, fails loudly, and the backward-compat shim in `common.ts` means zero churn to existing imports.

---

## 18. Strict static typing — `mypy` scoped to the API and LLM layer

**What changed.** `mypy>=1.11.0` was added to dev deps in `pyproject.toml`, and a `[tool.mypy]` block enables `strict = true` on a deliberately narrow scope with a **two-tier policy**:

```
[tool.mypy]
files = ["backend/api", "backend/services/llm.py"]
strict = true
follow_imports = "silent"
# Tier 2 — routers: relax untyped-def enforcement.
# Route handlers return dicts that FastAPI coerces via `response_model=`;
# forcing return annotations everywhere is churn without new safety.
disallow_untyped_defs = false
disallow_incomplete_defs = false
# Pragmatic relaxations (each can be tightened later, one knob at a time).
disallow_untyped_calls = false
disallow_any_generics = false
warn_return_any = false
implicit_reexport = true  # routers re-export through __init__

# Tier 1 — contracts: fully strict on models.py.
[[tool.mypy.overrides]]
module = ["backend.api.models"]
disallow_untyped_defs = true
disallow_incomplete_defs = true
```

Plus `[[tool.mypy.overrides]]` for stub-less third-party deps (`cv2`, `numpy`, `ultralytics`, `lapx`, `yt_dlp`, `anthropic`, `httpx`, `psutil`, `dotenv`, `openai`). Shipping the initial scope required real type fixes — not just annotations — in the llm + live routers:

- **`backend/services/llm.py`**: `_CB_STATE` typed as a `TypedDict` (fixed four `int | None` operand errors around the circuit breaker), `_DOWNGRADE.get(merged.get("readability"))` narrowed before the lookup, `resp.content[0].text` narrowed away from the `TextBlock | ToolUseBlock` union via `getattr`, and two targeted `# type: ignore[...]` annotations around the Anthropic structured-outputs beta kwarg (whose runtime fallback is already guarded by `except`).
- **`backend/api/routers/live.py`**: extracted `_resolve_slot(source_id)` helper so the two `?source_id=` routes stop rebinding a variable from `StreamSlot` to `StreamSlot | None` across branches.

**Three ways to run it.** **`make typecheck`** runs **`pyright`** against the `[tool.pyright]` `include` list (`backend/server.py`, `backend/startup.py`, `backend/state.py`, `backend/perception/emit.py`, `backend/security`, `backend/api`, …) at `typeCheckingMode = "basic"` — quick signal for the hot path + API surface, not full-repo strictness. **`make typecheck-mypy`** runs the strict scope above (`.venv/bin/python -m mypy --config-file pyproject.toml`). Use both alongside `make lint` (`py_compile` smoke on a few entrypoints).

**Why.** Two of the most failure-sensitive surfaces in the system — the request/response contracts and the LLM resilience layer — were the parts most worth typing first. Strictness elsewhere (perception hot path, integrations) would burn weeks on `numpy`/`cv2` annotations for marginal benefit.

**Why it matters.** Combined with §17, the wire boundary is now type-checked end-to-end: Pydantic-validated on the way in, **mypy-strict** on the API + LLM slice when you run `mypy`, **pyright** on the broader included tree when you run `make typecheck`, and TypeScript-strict on the frontend — refactors tend to surface before runtime. The LLM module is the other mypy strict-typed island, which matches its outsized role in the architecture (§13).

**Possible next improvements.**
- Widen scope incrementally: `backend/services/watchdog/` (now split — each sub-module has rich domain types) and `backend/services/impact.py` are the next candidates.
- Tighten relaxations one knob at a time (`disallow_untyped_calls` first — it catches the most real bugs).
- Add `mypy` to the PostToolUse hook in `.claude/hooks/` once the in-scope module count grows beyond what `py_compile` covers usefully.
- CI gate: fail the build on **`mypy`** errors in scope (orthogonal to **`make typecheck`**, which runs pyright).

**Alternative solutions & trade-offs.**
- **Alternative A: `pyright` (used by Pylance).** *Pros:* faster, better IDE integration, pyright is already mentioned in `pyproject.toml`'s `[tool.pyright]` block at `typeCheckingMode = "basic"`. *Cons:* `pyright` and `mypy` disagree on edge cases (Protocols, TypedDicts), and `mypy` has the stronger ecosystem of plugins (`pydantic.mypy` knows about `Field`, `model_config`, etc.).
- **Alternative B: Type the whole codebase at once with `--strict`.** *Pros:* uniform contract. *Cons:* the perception hot path uses `numpy.ndarray` in shapes that `mypy` can't express well without `nptyping` or runtime-validated wrappers; the cleanup would block the rest of the work for weeks.
- **Alternative C: Skip static typing, rely on runtime Pydantic validation.** *Pros:* "the data is checked when it matters". *Cons:* refactor errors (renaming a field on a model) only surface at runtime when that specific code path executes, which in a perception system can be hours into a session.
- **Verdict:** Narrow **`mypy --strict`** on the boundary modules (API + LLM), run it explicitly via **`python -m mypy --config-file pyproject.toml`**; keep **`pyright`** at **`basic`** for `make typecheck` / IDE feedback on the included paths. Widen mypy scope module-by-module as the team gains confidence — do not conflate the two commands in scripts or CI.

---

## 19. Honest gaps to volunteer

If the interviewer asks "what is still weak?", answer directly:

- **Auth is still the biggest product-readiness gap.** The doc is already honest about that; stating it proactively makes the rest of the architecture story more credible.
- **Type contracts are closed-loop but not yet fully CI-gated.** §17 + §18 landed Pydantic → generated TS (shipped as `make generate-types`, auto-run from `start.py`) and **mypy** strict on API + LLM (shipped as `make typecheck-mypy`), plus **`make typecheck`** → **pyright** on a configured include set (a different tool). Remaining work: codegen drift-check (`make generate-types && git diff --exit-code`) and **`make typecheck-mypy`** in CI; tightening any stray dict responses on the tests router against the test models.
- **A few frontend architecture rules are still aspirational.** The "no cross-feature imports" rule is directionally right, but the current tree still has exceptions that should be promoted into `shared/`.
- **Second-level decomposition is progressing.** Breaking up `server.py` was the first big win; the watchdog package split (`watchdog/{model,rules,ai,storage,api}.py`) was the second; the domain split (`backend/domain/episode.py`, `backend/domain/stream_slot.py`) — which §1 listed as pending in an earlier pass — is now on disk, with `backend/state.py` (791 → 400 LoC) re-exporting the names for backwards compat. Remaining file-level split candidates: `backend/services/impact.py` (813 LoC) and `backend/api/settings.py` (640 LoC).
- **Single-instance assumption.** `SettingsStore` is one in-memory singleton per edge process — no leader election, no fleet-wide config coordination yet.
- **Operational durability of JSONL stores.** `data/audit.jsonl` and `data/watchdog.jsonl` grow unbounded — rotation/compaction policy is implicit, not enforced.
- **No formal benchmarks.** Capacity envelope (§16) is order-of-magnitude reasoning, not measured numbers.
- **No browser-level end-to-end smoke suite.** Pytest unit tests + frontend vitest cover the units; nothing exercises the full SSE + MJPEG path against a live `start.py` yet.
- **Cold-start latency is still under-characterized.** `startup.py` does pre-warm YOLO, but there is no measured end-to-end "first live frame" benchmark for stream attach, first inference, and first UI paint.
- **Production packaging is not finished.** Missing auth is the obvious one, but no first-class HTTP/2 reverse-proxy recipe and no `docker-compose.prod.yml` either.

This section helps because it shows engineering judgment, not just feature enthusiasm.

---

## Quick-reference cheat sheet for Q&A

| Interview question | 30-second answer | Alternative they might ask about |
| --- | --- | --- |
| *Why split server.py?* | Monolithic `server.py` mixed routes, live state, and domain logic in one file. In `main` it was 1,535 lines (37 routes), and earlier internal snapshots had already drifted toward ~4,000 lines. Extracting 15 routers + 2 function-mounted routers + `state.py`/`startup.py`/`settings_store.py` cut `server.py` to **189 lines** and made per-feature testing possible. | Hexagonal/clean-arch layers — rejected as 3× ceremony for a single-process POC with one perception backend. |
| *Why Settings Console?* | Hot-apply runtime tuning with statistically-gated impact feedback (JSD scene drift, sample-size floor, confidence tiers) so operators aren't guessing whether a threshold change helped. | LaunchDarkly / Unleash — gets flags + audit but no perception-domain impact engine, which is the actual differentiator. |
| *MJPEG or polling — why both?* | Browsers cap HTTP/1.1 at 6 conns/host. MJPEG needs one per tile. HTTPS gets HTTP/2 multiplexing free; HTTP dev doesn't. Auto-detect by `window.location.protocol`. | WebRTC — sub-100 ms but needs STUN/TURN/SFU infra; overkill for 2 fps inference where frame-period latency is invisible. |
| *Why scrub plate at ingest, not egress?* | Defence in depth backwards. Egress scrub means every new buffer consumer must remember; ingest scrub means the raw plate was never in memory to leak. | KMS-encrypted at-rest with decrypt-on-egress — recoverable under audit but puts a KMS call on the hot path and doesn't shrink the in-memory leak surface. |
| *Why no auth?* | POC explicitly. Half-built auth is worse than documented none. Cloud receiver still HMAC-verifies batches; audit log still records every access. Real auth goes at the reverse proxy on deploy. | Static admin bearer token — sniffable on HTTP dev, no rotation, creates false confidence while offering almost nothing. |
| *Why TanStack Query?* | Kills hand-rolled `setInterval` polling, gives cache + `invalidateQueries`, supports `AbortSignal` out of the box for unmount cancellation, and integrates with React Suspense. | Redux Toolkit + RTK Query — single store but ceremony tax per slice and weaker Suspense/AbortSignal story than TanStack. |
| *Why was watchdog.py 1,800 lines and how is it split now?* | It used to own rules-before-AI layering + incident grouping/fingerprinting + JSONL persistence + the orchestration loop in one file. It now lives as the `backend/services/watchdog/` package: `model.py` (dataclass + fingerprinting + grouping), `rules.py` (deterministic detectors), `ai.py` (Claude hypothesis layer), `storage.py` (JSONL I/O), `api.py` (`Watchdog` loop + `stats()`). Rules win on fingerprint *or* title collision so monitoring never depends on LLM availability. HTTP routes live separately under `backend/api/routers/watchdog.py`. | Datadog / Sentry — mature UI but no perception-domain rules and needs outbound internet on the edge. |
| *Why strip dashcam?* | Two products were fighting — vehicle-mounted dashcam vs. fixed road-camera. Fixed-camera orientation policy (SAE J3063 N/S/E/W) is incoherent on a moving vehicle. One product done well. | `DEPLOYMENT_MODE` env flag to keep both — every gate branches, tests double, and the DMS privacy story is totally different from fixed-camera PII. |
| *Why feature-folder frontend?* | One engineer owns a feature end-to-end; `features/*` can't cross-import, shared code promotes to `shared/`. Lazy routes per page so one bundle failure doesn't nuke the others. | Next.js app-router with server components — nothing to SSR on a live operator dashboard; Vite SPA keeps the dev loop fast. |
| *Why `.claude` hooks + skills + rules?* | `py_compile` PostToolUse hook catches broken edits in <1 s. `.claude/rules/*.md` convert tribal invariants (no LLM outside `services/llm.py`, ≤5 tools/agent) into enforceable text for both humans and agents. | Heavy pre-commit with black/mypy/eslint — 30 s/commit, devs run `--no-verify`, no feedback mid-edit. |
| *Why one LLM module?* | One place to put the breaker, the cost ceiling, and the plate-hash. When a provider fails the rest of the system degrades gracefully (rules-only watchdog, skipped enrichment) instead of cascading. | LangChain / per-call SDK use — fragments breaker state, makes cost tracking impossible, re-opens the privacy invariant N times. |
| *Why HMAC on edge → cloud?* | Application-level message authentication. TLS proves you're talking to the right server; HMAC proves the batch was minted by an authorized edge. Receiver is also idempotent on event id, so retries are safe. | Trust TLS only — anyone with the URL can POST forged events; OAuth — needs an IdP every edge can reach (incompatible with air-gap). |
| *How does `SettingsStore` stay safe under concurrent reads?* | Atomic pointer rebind to a new immutable `MappingProxyType` snapshot under a short `RLock`; readers call `STORE.snapshot()` lock-free. A reader never blocks a writer, a writer never blocks readers, and no one ever sees a partially-applied diff. | Mutex-per-read — wrong order of magnitude on the hot path; SQLite-per-read — adds microseconds where we need nanoseconds. |
| *How is the wire contract kept in sync between Python and TS?* | Pydantic models in `backend/api/models.py` are the source of truth. `scripts/generate_ts_types.py` emits `frontend/src/shared/types/generated.ts` (462 LoC); the legacy `common.ts` is now a 50-line re-export shim. `start.py` regenerates types before every Vite build, and `make generate-types` runs codegen standalone. | OpenAPI codegen — needs `response_model=` everywhere first; hand-written types — exactly the regime we just left. |
| *Why mypy on a narrow scope rather than the whole codebase?* | Strict **`mypy`** where wire contracts and provider failover live (`backend/api`, `backend/services/llm.py`), with a **two-tier policy**: fully strict on `backend.api.models` (the contract), strict-minus-untyped-defs on routers (their returns are already constrained by `response_model=`). Relaxed defaults elsewhere because typing `numpy`/`cv2`/`ultralytics` shapes is weeks of cleanup for marginal value. Run **`make typecheck-mypy`**. **`make typecheck`** is separate — it runs **`pyright`** on the `[tool.pyright]` include list, not mypy. | `mypy --strict` everywhere — blocks the rest of the work; **pyright-only** — different guarantees; optional **`pydantic.mypy`** plugin if you add it to `pyproject.toml` for stricter Pydantic-aware checks. |
| *What's the capacity envelope?* | Bounded by browser HTTP/2 multiplexing and TARGET_FPS, not by Python. Encode-only-when-watched, lock-free config reads, async LLM. Honest answer: "depends on resolution + GPU + tile count, but the architecture isn't the bottleneck." | Quoting a fake "N cameras per edge" number — interviewers will probe and you'll have nothing to back it up. |
| *How is documentation organised?* | `CLAUDE.md` is the agent contract (invariants to enforce). `docs/audit/*` and `docs/improvements/*-audit-2026-04-20.md` are diligence-ready. `docs/architecture.md` is for newcomers. ADRs are the next step. | Notion-only — drifts from code, agent can't read it; mkdocs site — agents read markdown by path, not generated HTML. |
| *What invariants must not break?* | (1) No raw plate in any buffer. (2) Don't short-circuit conflict gates — each kills one FP class. (3) LLM calls only through `services/llm.py` (failover + rate budget + circuit breaker + cost tracking). (4) ≤5 tools per agent (hallucination grows above that). (5) Paths only from `backend/config.py`. (6) `SettingsStore` writes are atomic snapshot rebinds — never mutate in place. (7) Edge → cloud batches are HMAC-signed and idempotent. | Relaxing any of these "for speed" — each has a documented FP class, outage mode, or hallucination mode it was added to prevent. |
