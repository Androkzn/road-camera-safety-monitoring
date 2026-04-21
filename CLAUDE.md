# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

- `python start.py` — one-command launcher: builds the React frontend, runs the pytest suite, starts `backend.server:app` via uvicorn on port 8000, waits for `/api/live/status`, then opens the admin UI in the browser.
- `python start.py --skip-tests` — skip the test run (fastest iteration loop).
- `python start.py --cloud` — also start the cloud receiver (`cloud.receiver:app`) on port 8001.
- `python start.py --no-browser --port 8000` — headless start.
- `make test` / `pytest tests/ -v` — full test suite.
- `pytest tests/test_core.py::test_name -v` — run a single test.
- `make lint` — cheap syntax check (`py_compile` on `backend/server.py`, `backend/config.py`, `start.py`); there is no formatter or type-checker wired up.
- `cd frontend && npm run build` — TypeScript + Vite production build into `frontend/dist/`. `start.py` does this automatically before launching the server.
- `cd frontend && npm run dev` — Vite dev server (only needed when iterating on frontend separate from the Python server).
- `docker compose up --build` / `make docker-up` — containerized run; `--profile cloud` or `make docker-up-cloud` adds the receiver.

The server is served from the built `frontend/dist/` (see `STATIC_DIR` in `backend/config.py`), so backend-only changes do **not** require rebuilding the frontend. If `frontend/dist/` is missing, the static-files mount fails at boot — run `cd frontend && npm run build` first (or `python start.py`, which builds it for you).

Python dependencies live in a local `.venv`; `start.py` prefers `.venv/bin/python` over the system interpreter. Install with `pip install -e ".[dev]"`.

## Architecture

This is a two-process system: an **edge node** (the main `backend.server`) that runs heavy perception on-device, and an optional **cloud receiver** (`cloud/receiver.py`, port 8001) that ingests HMAC-signed batched events into SQLite. Only typed JSON events + redacted thumbnails cross the wire — never raw frames or plate text. See `docs/architecture.md` for the full diagram and bandwidth math.

### Conflict-detection pipeline (the hot path)

Each frame flows through an independent stack of gates in `backend/core/` and `backend/perception/on_frame.py`. A real conflict satisfies all gates; noise fails early:

1. `StreamReader` pulls frames (HLS, file, webcam, or YouTube via `yt-dlp`) at `TARGET_FPS` (default 2 fps).
2. `detect_frame` (`core/detection.py`) runs YOLOv8 + ByteTrack.
3. `TrackHistory` maintains per-track trailing windows for TTC math.
4. `EgoMotionEstimator` (`core/egomotion.py`) computes optical-flow ego-speed proxy.
5. `SceneContextClassifier` (`core/context.py`) tags urban/highway/parking and rescales thresholds.
6. `find_interactions` → depth-gate → convergence-angle → ego-relative-motion → multi-gate TTC (`estimate_pair_ttc` / `estimate_ttc_sec`).
7. `QualityMonitor` (`core/quality.py`) suppresses low-confidence events when the camera is degraded.
8. `Episode` accumulates peak risk across frames; sustained-risk downgrade demotes peaks not supported over ≥2 frames / ≥1s.
9. `emit_event()` (`backend/perception/emit.py`) redacts thumbnails, optionally narrates via LLM, broadcasts over SSE, tier-dispatches to Slack, and publishes to cloud.

**Do not short-circuit these gates to "improve" detection** — each one exists to kill a specific class of false positive that was causing alert fatigue. If you change a gate, run the integration tests in `tests/test_core.py`.

### Privacy invariant (non-obvious)

`enrich_event()` in [backend/services/llm.py](backend/services/llm.py) hashes the plate and strips `plate_text`/`plate_state` from the returned dict **before** it reaches any in-memory event buffer. The emit path in [backend/perception/emit.py](backend/perception/emit.py) keeps a defence-in-depth `pop()`, but the primary invariant — **no raw plate text in any buffer** — is enforced at ingest, not at egress. Any new code path that touches vision-enrichment output must preserve this. Dual thumbnails (internal + public) are produced by `services/redact.py::write_thumbnails`; shared channels must only use the `_public` variant.

### LLM layer is enrichment, not critical path

Detection works with zero LLM calls. The LLM layer has multi-provider failover (Anthropic ↔ Azure OpenAI), a client-side token-bucket rate budget, a circuit breaker (3 failures → 60s open), self-consistency ALPR (two calls at different temps, null on disagreement), and cost/latency tracking in [services/llm_obs.py](backend/services/llm_obs.py). External ALPR is gated by `ROAD_ALPR_MODE` (default `off`). When adding LLM calls, route them through the existing `llm.py` helpers so they inherit all of this.

### Package layout

- `backend/core/` — perception: detection, stream, egomotion, quality, context.
- `backend/services/` — LLM, redaction, drift, watchdog, agents, registry, digest, test_runner.
- `backend/compliance/` — `audit.py` (audit log) and `retention.py` (hourly retention sweeps).
- `backend/integrations/` — `edge_publisher.py` (HMAC batched delivery), `slack.py`, `fnol.py`.
- `backend/api/routers/` — feature routers mounted by `backend/server.py`.
- `backend/api/feedback.py` and `backend/api/settings.py` — feature mounts that need shared callbacks/state during registration.
- `backend/config.py` — **single source of truth** for paths and env vars. Every module imports from here; never compute `Path(__file__).parent` in modules.
- `backend/logging.py` — JSON-line logger setup (`setup()` called once from the FastAPI lifespan hook). Deliberately has no dependency on `config.py` so it can import early in bootstrap. `ROAD_LOG_FORMAT=text` switches to human-readable output for local dev.
- `backend/security/` — network-level guards only: SSRF rejection (`ssrf.py`) and the per-IP clip-render rate limiter (`rate_limit.py`). This POC has no request authentication.
- `tools/` — offline utilities: `analyze.py` (batch event extraction from a video file), `eval_detect.py` (detection precision/recall harness), `eval_enrich.py` (LLM enrichment scorer). See [tools/README.md](tools/README.md).
- `cloud/receiver.py` — separate FastAPI app; verifies HMAC, dedupes by `event_id` (`INSERT OR IGNORE`), stores in `data/cloud.db`.
- `frontend/` — React 19 + Vite + TypeScript + react-router. Pages: `AdminPage` (live detections), `DashboardPage` (fleet overview), `MonitoringPage` (incident-queue watchdog).

### Access model (POC)

This POC has no user accounts, no roles, and no request authentication. Every JSON route, SSE stream, and live media endpoint is fully open. Do not expose this build to the public internet.

Access to sensitive state is still audit-logged through `backend/compliance/audit.py` so a reviewer can reconstruct activity, and the cloud receiver still verifies HMAC signatures on edge-to-cloud ingest (message authentication, not user authentication). Any future production deployment must introduce a real auth layer before going live.

### Fleet identity

Every event carries `vehicle_id`, `road_id`, `driver_id` sourced from env (`ROAD_VEHICLE_ID` / `ROAD_ID` / `ROAD_DRIVER_ID`). On startup without these, the server logs a warning and falls back to `unidentified_*_<hostname>` — events will not attribute to a real fleet. The driver safety-score model (`services/registry.py`) decays on a schedule controlled by `ROAD_SCORE_DECAY_INTERVAL_SEC` (set `0` to disable).

### Live video transport (admin grid)

The multi-source admin grid (`frontend/src/components/admin/MultiSourceGrid.tsx`)
renders one live tile per perception source via `StreamImage`
(`frontend/src/components/admin/StreamImage.tsx`). It picks one of two server
endpoints based on the page protocol:

- **HTTPS → MJPEG** (`GET /admin/video_feed/{id}`, `multipart/x-mixed-replace`).
  One persistent connection per tile; the server pushes each freshly-encoded
  JPEG with no polling latency floor.
- **HTTP → polling** (`GET /admin/frame/{id}`, single JPEG every ~400 ms).
  Used in local dev where uvicorn speaks HTTP/1.1 directly and the browser's
  6-concurrent-connections-per-host cap would deadlock MJPEG once you have
  more than ~4 tiles open alongside SSE.

**Deploy implication**: any production deployment with ≥6 streams **must**
front uvicorn with an HTTP/2 reverse proxy (nginx, Caddy, Cloudflare, ALB).
HTTP/2 multiplexes all streams over one TCP connection, dissolving the
6-conn cap. TLS termination at the proxy is what flips the frontend into
MJPEG mode automatically — no client config needed.

Operators can override the auto-detection at build time via the Vite env
var `VITE_ROAD_VIDEO_TRANSPORT=mjpeg|poll` (useful for h2c-cleartext
deployments or for forcing polling during transport debugging). The
server keeps both endpoints live regardless, so `/admin/frame/{id}` is
also available for one-shot snapshots and tests.

### Watchdog

`services/watchdog/` groups repeated errors into fingerprinted incidents with impact + likely cause + owner + evidence + debug commands. The design goal is an **incident queue**, not a log-tail wall of red; preserve this when extending it.

The package splits four concerns so monitoring never depends on LLM availability:

- `watchdog/model.py` — the `WatchdogFinding` dataclass, fingerprinting, defaults table, normalization, grouping, and `make_finding`. Shape-only, no I/O.
- `watchdog/rules.py` — deterministic rule-based detectors (`rule_checks`). Always available; never imports the LLM.
- `watchdog/ai.py` — strictly-additive Claude hypothesis layer (`ai_analyze`). Returns `[]` when the LLM stack is unreachable so the rule layer carries on alone.
- `watchdog/storage.py` — append-only JSONL writer/reader for `data/watchdog.jsonl`.
- `watchdog/api.py` — the `Watchdog` background loop + `stats()` aggregator surfaced to `/api/watchdog`.

**Invariant**: on fingerprint OR title collision between a rule and an AI finding, the rule wins — that's what makes the queue stay trustworthy when the provider is flaky.

## Things to avoid

- **Don't compute paths manually** — import from `backend/config.py`.
- **Don't leak raw plate text** — scrub at ingest in `enrich_event()`, not just at egress.
- **Don't add LLM calls outside the `services/llm.py` wrappers** — you'll bypass failover, rate budget, circuit breaker, and cost tracking.
- **Don't widen an agent's tool set past 5** — `services/agents.py` enforces this deliberately (tool-overload hallucination grows past ~5 tools).
- **Don't remove conflict-detection gates to "catch more"** — each gate targets a specific false-positive class; loosen thresholds per-scene via `AdaptiveThresholds` instead.
