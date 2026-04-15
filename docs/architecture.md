# Edge/Cloud Architecture

## Why split?

Samsara engineers have publicly stated the constraint plainly: low-latency ML
inference has to happen on-device, and several TB/month of HD video per vehicle
rules out a cloud-only design. The demo reflects that. Heavy perception, PII
redaction, and event construction run on the edge. Only typed JSON + small
redacted thumbnails cross the wire, signed with HMAC.

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
|                   GET /events, /stats  -> Dashboard                   |
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
string), `thumbnail_url` + `thumbnail_sha256` pointing at a redacted JPEG.

**Never crosses:** raw frames, unredacted thumbnails, plate text, face crops,
GPS tracks finer than the event summary, any audio.

This means a cloud breach leaks event metadata and blurred thumbs, not
identifiable PII.

## Why HMAC and not mTLS

HMAC-SHA256 over `f"{timestamp}.{body}"` is one shared secret per edge node,
trivial to rotate via config, and works through any HTTPS proxy. Because the
payload is already scrubbed, confidentiality is provided by TLS and integrity
by the HMAC; we do not need strong client identity. mTLS is a reasonable
upgrade once there is a real PKI and a road-management plane to rotate
client certs; for a demo it is operational overkill.

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

## LLM Resilience

- **Multi-provider failover:** if Anthropic returns an error, the completion
  path transparently retries via Azure OpenAI (or vice versa). Operators see
  zero downtime as long as at least one provider is available.
- **Circuit breaker:** vision enrichment tracks consecutive failures; after 3
  it opens the breaker for 60s to let rate limits recover.
- **Client-side rate budget:** a token-bucket limiter (3 req/min) refuses LLM
  calls *before* they 429, cheaper than absorbing failures.
- **Cost observability:** `road_safety/services/llm_obs.py` tracks per-call token counts, latency
  percentiles, and estimated USD cost. Exposed via `/api/llm/stats`.

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

- **`road_safety/compliance/retention.py`** runs hourly sweeps: thumbnails (30d), feedback (90d),
  active-learning samples (60d), outbound queue (7d). All configurable via env.
- **`road_safety/compliance/audit.py`** logs every access to sensitive resources (unredacted thumbnails,
  feedback submissions, AL exports, agent invocations, chat queries) with
  timestamp, actor, action, resource, and outcome.
- **DSAR workflow:** unredacted thumbnails require `X-DSAR-Token` header; denied
  attempts are audit-logged.

## Multi-Vehicle Road Model

- Each event carries `vehicle_id`, `road_id`, `driver_id` from env config.
- `road_safety/services/registry.py` maintains an in-memory registry with per-vehicle event counts,
  safety scores (decaying penalty model), and driver leaderboard.
- `/api/road/summary` provides road-wide aggregation; `/api/road/drivers`
  ranks drivers by safety score (worst-first for manager attention).
