# Edge/Cloud Architecture

## Why split?

Two physical constraints force the split. First, safety-critical perception
must complete within the round-trip latency budget; cloud RTTs over cellular
links exceed that budget under load. Second, sustained HD video upload from
each vehicle is in the multi-TB/month range, which is uneconomic and impossible
on intermittent connectivity. The platform runs heavy perception, PII redaction,
and event construction on the edge. Only typed JSON and small redacted
thumbnails cross the wire, signed with HMAC.

## Diagram

```
+-------------------------- EDGE NODE (vehicle) -------------------------+
|                                                                        |
|  [camera / HLS] --> StreamReader --> YOLOv8 + ByteTrack --> redact    |
|                         (2 fps)        (detect + track)      (blur    |
|                                                               faces, |
|                                                               plates)|
|                                            |                          |
|                                            v                          |
|                           event JSON  +  public_thumb.jpg             |
|                                            |                          |
|                                            v                          |
|                           EdgePublisher (async)                       |
|                           - outbound_queue.jsonl  (append-only)       |
|                           - batch N events, HMAC sign, POST           |
|                           - expo backoff on failure, drain on recover |
|                                            |                          |
+--------------------------------------------|--------------------------+
                                             |
                      HTTPS + Signature: sha256=...
                      X-Road-Timestamp: <unix>
                                             |
+-------------------------------- CLOUD ---------------------------------+
|                                            v                          |
|                    cloud/receiver.py (FastAPI, uvicorn :8001)         |
|                      POST /ingest/events  (verify HMAC, dedup)        |
|                              |                                        |
|                              v                                        |
|                         SQLite  data/cloud.db                         |
|                              |                                        |
|                              v                                        |
|                   GET /events, /stats  -> Protected ops access        |
+------------------------------------------------------------------------+
```

## Bandwidth math (the 10,000x)

- Raw HD stream: ~10 Mbps sustained ~= 108 GB/day/camera. Realistic encoded
  dashcam continuous upload is closer to ~1 GB/day/stream after aggressive
  compression. Call it **1 GB/day/stream**.
- Events: 50/day at ~2 KB JSON + 8 KB redacted thumb = ~500 KB/day/stream.
- Ratio: **1 GB / 500 KB ~= 2,000x**, and against uncompressed HD closer to
  **10,000x**. Either way it turns a bandwidth-bound problem into an
  essentially free one.

## What crosses the edge boundary

**Crosses:** `event_id`, `ts_start`, `ts_end`, `event_type`, `risk_level`,
`ttc_sec`, `distance_m`, `track_ids`, `plate_hash` (SHA-256, never the plate
string), and (when `ROAD_EDGE_PUBLIC_URL` is set) `thumbnail_url` +
`thumbnail_sha256` pointing at a redacted JPEG.

**Never crosses the edge-to-cloud event path:** raw frames, unredacted thumbnails,
plate text, face crops, GPS tracks finer than the event summary, any audio.

This means a cloud breach leaks event metadata and blurred thumbs, not the
internal thumbnails or raw plate text. Optional third-party vision enrichment,
if enabled, is a separate processor path and should be documented separately.

## Why HMAC and not mTLS

HMAC-SHA256 over `f"{timestamp}.{body}"` is one shared secret per edge node,
trivial to rotate via config, and works through any HTTPS proxy. Because the
payload is already scrubbed, confidentiality is provided by TLS and integrity
by the HMAC; strong client identity is unnecessary. mTLS is a supported
upgrade path once a fleet-wide PKI and certificate management plane are in
place; absent that infrastructure it adds operational cost without
proportional security benefit.

## Offline resilience

The edge publisher writes every event to an append-only JSONL queue
(`data/outbound_queue.jsonl`) **before** attempting delivery. On cloud
unreachable, items simply stay in the file; the flush loop retries with
exponential backoff. On reconnect it drains in FIFO order. This gives
**at-least-once** delivery; `event_id` is the idempotency key and the cloud
side dedupes on it (see `INSERT OR IGNORE` in `cloud/receiver.py`).

## Failure modes

- **Clock skew:** signed `X-Road-Timestamp` enforced within +/- 300 s. Clocks
  drift; 5 min is the standard webhook window (Stripe, Slack).
- **Replay:** `event_id` dedup on cloud side means a replayed batch is a
  no-op. The timestamp window additionally bounds replay to 5 minutes.
- **Secret leak:** rotate `ROAD_CLOUD_HMAC_SECRET`, redeploy both sides;
  events signed with the old secret fail verification and get 401'd.
- **Queue growth during long outage:** JSONL is trimmed from the head once
  ack'd; operator alert wired through `/stats.last_received_at` staleness.

## Conflict-Detection Pipeline

Each frame passes through an independent stack of gates before an event is
emitted. A real conflict satisfies all of them; a noisy frame fails at the
first.

```
  detect_frame  ─►  YOLOv8 + ByteTrack         identity-persistent detections
       │
       ▼
  TrackHistory  ─►  trailing N-sample ring     per-track centre + height + bottom
       │
       ▼
  EgoMotionEstimator (Farneback on background) ego flow vector + speed proxy
       │
       ▼
  SceneContextClassifier                       urban / highway / parking / unknown
       │                                       → AdaptiveThresholds (TTC, distance)
       ▼
  find_interactions                            candidate pairs by class + edge px
       │
       ▼
  depth-aware proximity gate (vehicle-vehicle) reject pairs > 8 m apart in 3D
       │
       ▼
  convergence-angle filter (vehicle-vehicle)   reject parallel / same-direction
       │
       ▼
  ego-relative motion gate                     discard TTC if no track approaching
       │
       ▼
  multi-gate TTC (estimate_pair_ttc /          monotonic growth, jitter floor,
   estimate_ttc_sec)                           min track motion, scale ratio
       │
       ▼
  speed-aware risk floor                       cap at medium when ego < 2 m/s
       │                                       and no approach detected
       ▼
  Episode (per-pair, peak-frame buffered)      accumulate risk frame counts
       │                                       across episode lifetime
       ▼
  sustained-risk downgrade (Episode.final_risk)
       │                                       demote peak risk if not supported
       ▼
  _emit_event                                  redact, narrate, broadcast (SSE),
                                               tier dispatch (Slack), publish (cloud)
```

Slack `notify_high` applies a final quality gate on episode duration,
sustained high-risk frame count, and detection confidence; failed events
route to the medium digest. High-risk Slack alerts are text-only by default;
image relay is opt-in via `SLACK_ENABLE_IMAGE_RELAY=1`.

## Domain objects vs state

The per-source domain classes ([`Episode`](../backend/domain/episode.py) and
[`StreamSlot`](../backend/domain/stream_slot.py)) live under
[backend/domain/](../backend/domain/). They model the *shape* of the
perception pipeline — temporal de-duplication across frames, per-camera
estimator state, the MJPEG buffer, stage-timing ring buffers.

The process-wide singleton ([`LiveState`](../backend/state.py)) stays in
`backend/state.py`; it owns the YOLO model handle, the asyncio event loop,
SSE subscribers, the recent-events buffer, and the slot registry. Splitting
domain objects out of the singleton keeps each file focused on one
responsibility — the 800-line `state.py` dropped to ~400 lines, and the
domain classes no longer drag the whole singleton in when you import them.

`backend/state.py` re-exports `Episode` and `StreamSlot` for backwards
compatibility, so existing `from backend.state import Episode, StreamSlot`
imports keep working. New code should import from `backend.domain`.

## Wire Contract and Codegen

Every cross-process JSON shape is declared once, as a `pydantic.BaseModel`
in [backend/api/models.py](../backend/api/models.py). That module is the
**single source of truth** for the SSE `SafetyEvent`, the `/api/live/status`
dense summary, the `/api/admin/health` composite, per-source status,
per-frame `DetectionSnapshot`, watchdog findings, test-runner output, and
every other payload the backend emits.

TypeScript interfaces are generated from those models into
[frontend/src/shared/types/generated.ts](../frontend/src/shared/types/generated.ts)
by [scripts/generate_ts_types.py](../scripts/generate_ts_types.py). The
hand-maintained [frontend/src/shared/types/common.ts](../frontend/src/shared/types/common.ts)
now re-exports the generated types so existing imports keep working.

Pipeline:

1. Edit a `BaseModel` in `backend/api/models.py`.
2. `python scripts/generate_ts_types.py` (or `make generate-types`) walks
   `EXPORTED_MODELS`, calls `model_json_schema()` on each, and emits a
   TypeScript file — interfaces, JSDoc carried over from Python docstrings,
   `Literal[...]` unions preserved as string-literal unions, nullable
   optionals collapsed to the `field?: T` convention, and fixed-length
   tuples emitted as TS tuples so indexing stays type-safe under
   `noUncheckedIndexedAccess`.
3. `start.py` runs the script **before** `npm run build`, so a model edit
   that breaks the frontend fails at TS compile time in the same launch.

**Do not hand-edit `generated.ts`** — it is clobbered on the next launch.

## Type Checking

Two tools run side-by-side:

- **pyright** (basic mode, project-wide) — see `[tool.pyright]` in
  `pyproject.toml`. Kept broad so everyday churn doesn't block on missing
  annotations.
- **mypy** (strict, narrow scope) — `[tool.mypy]` in `pyproject.toml`
  enforces strict typing on two high-value slices:
    - `backend/api/` — the wire contracts and the routers that serve them.
      Router handlers keep `disallow_untyped_defs = false` because their
      return values are already constrained by `response_model=…`; the
      `backend.api.models` override flips it back on so the contract
      module stays fully annotated.
    - `backend/services/llm.py` — the LLM failover, rate budget, and
      circuit breaker. Bugs there silently degrade enrichment and cost
      visibility.
  Run with `make typecheck-mypy`.

Widening mypy coverage is tracked as a follow-up; each new slice pays for
itself only after its initial annotations land, so we add them one module
at a time.

## LLM Resilience

- **Multi-provider failover:** if Anthropic returns an error, the completion
  path transparently retries via Azure OpenAI (or vice versa). Operators see
  zero downtime as long as at least one provider is available.
- **Circuit breaker:** vision enrichment tracks consecutive failures; after 3
  it opens the breaker for 60s to let rate limits recover.
- **Policy gate:** external ALPR is disabled by default. `ROAD_ALPR_MODE=third_party`
  is required before any internal thumbnail is sent to a third-party vision model.
- **Client-side rate budget:** a token-bucket limiter (3 req/min) refuses LLM
  calls *before* they 429, cheaper than absorbing failures.
- **Cost observability:** `backend/services/llm_obs.py` tracks per-call token counts, latency
  percentiles, and estimated USD cost. Exposed via `/api/llm/stats` (open in the POC build).

## AI Agent Orchestration

Three tool-calling agents, each with ≤5 tools to avoid the tool-overload
hallucination problem (industry data: >30 tools → 21% wrong tool selection):

| Agent | Tools | Output |
|---|---|---|
| Coaching | get_event, get_policy, get_recent_events | Structured coaching note JSON |
| Investigation | +get_feedback, +get_drift_report | Root-cause analysis JSON |
| Report | count_by_type/risk, get_feedback, get_drift_report, get_recent_events | Safety summary JSON |

Max iteration cap (5 steps) prevents runaway loops.

## Data Retention & Compliance

- **`backend/compliance/retention.py`** runs hourly sweeps: thumbnails (30d), feedback (90d),
  active-learning samples (60d), outbound queue (7d). All configurable via env.
- **`backend/compliance/audit.py`** logs every access to sensitive resources (thumbnails,
  feedback submissions, AL exports, agent invocations, chat queries) with
  timestamp, action, resource, and outcome.
- **POC access model:** this build has no user accounts, roles, or request authentication. Every JSON route, SSE stream, and live-media endpoint is fully open. Audit logging still records activity so a reviewer can reconstruct access after the fact. Do not expose this build to the public internet.

## Multi-Vehicle Road Model

- Each event carries `vehicle_id`, `road_id`, `driver_id` from env config.
- `backend/services/registry.py` maintains an in-memory registry with per-vehicle event counts,
  safety scores (decaying penalty model), and driver leaderboard.
- `server.py` runs scheduled score recovery (`road_registry.decay_scores()`)
  controlled by `ROAD_SCORE_DECAY_INTERVAL_SEC` (set `0` to disable).
- `/api/road/summary` provides road-wide aggregation; `/api/road/drivers`
  ranks drivers by safety score (worst-first for manager attention). These
  endpoints are open in this POC (no authentication anywhere); add auth before any production deployment.
