# Running the App: Local & Production

This doc covers:

1. What the app is.
2. How to run it locally (just `make start`).
3. How the local process actually works.
4. What's missing for production, and how to add it — with trade-offs.

> **This is a POC (proof of concept).** It is **not** production-ready
> as-shipped. It has no authentication, uses SQLite + local disk for
> state, serves the React UI from the same process as the perception
> workers, and has no horizontal-scaling story. All of those are
> intentional for a POC — the goal was to validate the perception
> pipeline end-to-end, not to survive a production SLA.
>
> Section 5 describes the **real deployment** we'd build if this
> product ran against **1,000+ fixed road cameras**. Section 6
> sequences the work from today's POC to that target.

---

## 1. What the app is

**Road-camera safety monitoring.** Pulls video from fixed road cameras
(intersection cams, highway poles, parking-structure cams) over HLS /
RTSP / YouTube live streams. Runs YOLOv8 object detection + tracking on
each frame, redacts PII (plates, faces), and emits conflict events when
vehicles or pedestrians approach a near-miss.

There are no cameras in vehicles. No on-vehicle hardware. Every
camera is third-party infrastructure at a fixed location.

---

## 2. How to run it locally

One command:

```bash
make start
```

That's it. Logs stream to your terminal. Ctrl+C stops.

### What `make start` does under the hood

1. **Pre-flight cleanup** — frees port 8001 and kills any stray
   `yt-dlp` / `ffmpeg` workers from a previous run, so the command is
   idempotent (you can run it twice in a row without errors).
2. **Launches `start.py`** — a convenience script that:
   - Builds the React frontend (`npm run build` → `frontend/dist/`).
   - Skips the pytest suite (`--skip-tests` baked in).
   - Launches `uvicorn road_safety.server:app --port 8001`.
   - Waits for `/api/live/status` to return `200`.
3. **Ctrl+C** triggers a cleanup trap that sends `SIGTERM` to the
   whole process group, then `SIGKILL` to anything that didn't exit
   within 0.5s. Catches the yt-dlp / ffmpeg children too, which
   otherwise ignore the first signal.

### Where the app runs

Always on **your Mac**. Opens at `http://localhost:8001`. Nothing
touches AWS, no remote state, no cloud calls except the video pull
from YouTube / the camera CDN (and optional LLM enrichment if
`ANTHROPIC_API_KEY` is set in `.env`).

### Where data lives

- **Built React bundle:** `frontend/dist/` (regenerated on every
  `make start`).
- **Thumbnails, DB, JSONL event logs:** `data/` directory.
- **YOLOv8 model weights:** `yolov8s.pt`, `rtdetr-l.pt` at the repo
  root. Auto-downloaded on first run.
- **Config:** `.env` + defaults in [road_safety/config.py](../road_safety/config.py).

### Thumbnail retention (demo setup)

Each detected event writes **two JPEG files** to `data/thumbnails/`:

- `evt_xxx.jpg` — internal, unredacted (for forensics / labeling).
- `evt_xxx_public.jpg` — plates and faces blurred (for Slack, LLM,
  dashboard).

At ~2,600 events/day across 6 cameras that's ~570 MB/day of thumbnails
on local disk. To prevent unbounded growth, `.env` sets:

```
ROAD_RETENTION_THUMBNAILS_DAYS=0
```

Which makes the hourly retention loop at
[road_safety/compliance/retention.py](../road_safety/compliance/retention.py)
sweep "anything older than 0 days" → everything gets cleared every
hour. Disk stays under ~25 MB.

**This is a demo hack. Production does it differently** — see Section
5.2.

---

## 3. How it works (one process, one port)

```
  ┌────────────────────────────── your Mac ────────────────────────────────┐
  │                                                                         │
  │   ┌─────────────────────────────────────────────────────────────────┐   │
  │   │  uvicorn (one Python process, port 8001)                        │   │
  │   │                                                                 │   │
  │   │   road_safety.server:app  (FastAPI)                             │   │
  │   │   │                                                             │   │
  │   │   ├─ background asyncio tasks (one per camera):                 │   │
  │   │   │    StreamReader → YOLOv8 → ByteTrack → gates → Episode      │   │
  │   │   │                                                             │   │
  │   │   ├─ static files:  frontend/dist/  (the React UI)              │   │
  │   │   │                                                             │   │
  │   │   └─ HTTP routes:                                               │   │
  │   │        GET /             → index.html (React shell)             │   │
  │   │        GET /api/...      → JSON (status, events, settings)      │   │
  │   │        GET /stream/events→ SSE (live event push)                │   │
  │   │        GET /admin/video_feed/{id} → MJPEG stream                │   │
  │   └───┬─────────────────────────────────────────────────────────────┘   │
  │       │                                                                 │
  │       │ spawns N child processes at startup (one per camera feed):      │
  │       ▼                                                                 │
  │   yt-dlp ──pipe──▶ ffmpeg ──pipe──▶ (back into Python as raw frames)    │
  └─────────────────────────────────────────────────────────────────────────┘
              ▲                           │
              │ HTTPS (camera CDN)        │ HTTP to browser
              │                           ▼
    [Road-cam HLS / YouTube live]  [Safari/Chrome on localhost:8001]
```

### Entry point

Everything reduces to one line:

```bash
uvicorn road_safety.server:app --port 8001
```

- `uvicorn` = the web server process (binds the port, handles HTTP).
- `road_safety.server:app` = the FastAPI application object (your code).
- `make start` / `start.py` / `Dockerfile CMD` are all just wrappers
  around this.

### Step-by-step

1. FastAPI's **lifespan hook** loads YOLOv8, warms the model, reads
   `ROAD_STREAM_SOURCE` from `.env`.
2. For each camera URL in `.env`, Python spawns a `yt-dlp` +
   `ffmpeg` pipe that decodes frames back into the Python process
   at ~2 fps.
3. Each camera runs an **asyncio task** with the perception pipeline:
   YOLOv8 → tracking → gates → Episode.
4. Events that pass all gates are **broadcast over SSE** + written
   to `data/` as JSONL + thumbnail.
5. Your browser opens `http://localhost:8001`, receives the React UI
   from `frontend/dist/`, and opens an SSE connection to receive
   live events.

### Why everything is in one process

Perception and the admin UI share memory: the UI's MJPEG stream reads
the latest annotated frame straight from the perception task's output
buffer. No IPC, no queue hop. This is the right design for a POC — it
collapses a lot of complexity. It's also the thing that most needs to
change before production (see Section 5).

---

## 4. POC scope

The intent of this build is to validate:

- The perception pipeline (detection → tracking → gates → events).
- PII redaction as a privacy invariant enforced at ingest.
- The operator experience (live dashboard, incident queue, watchdog).
- LLM enrichment with failover and cost tracking.

It is **not** intended to:

- Handle more than ~10 concurrent cameras.
- Survive a production SLA.
- Be exposed to the public internet.
- Support multiple operators with different permissions.
- Persist state across container restarts in a managed environment.

Section 5 lists what you'd change to get there.

---

## 5. Real deployment at 1,000+ cameras

The POC tops out at ~10 cameras on a single box. A real deployment
running **1,000+ fixed road cameras** is a different system — different
boundaries, different failure modes, different cost structure. This
section describes that system concretely: what each piece is, why it's
there, what it costs, and what breaks.

### 5.0 What the workload actually looks like

Order-of-magnitude figures, used to size everything below:

| Metric | Value |
|---|---|
| Inference throughput | ~2,000 frames/sec (1,000 cams × 2 fps) |
| Events/day (fleet-wide) | 50,000–100,000 conflict candidates |
| High-risk events/day (LLM-enriched) | ~5,000 |
| Thumbnail write volume | ~100 GB/day, ~3 TB over 30 days |
| Concurrent live viewers | 10–100 operators |
| Baseline camera churn | 5–10% of fleet offline at any instant |
| Tenants (cities / agencies / districts) | 5–50 typical |

These drive the architecture: the fleet does **not** fit on one box,
events must fan out to multiple independent consumers, thumbnails must
live in object storage, and something has to reassign work when a
perception worker dies. Every assumption in the POC breaks.

### 5.1 Authentication and multi-tenant access

**Reality at scale:** 1,000 cameras usually means multiple operator
teams (city A, city B, highway district, parking authority), each
restricted to their own cameras. Plus admins, auditors, DSAR handlers,
and an ops/SRE team with cross-tenant read access.

**What you need:**
- **Identity:** Cognito User Pools with SAML/OIDC federation to
  enterprise SSO (Okta, Entra ID, Google Workspace). Self-managed
  users don't scale past a few dozen seats.
- **Authorization:** policy-based, not role-based. Every API call
  resolves `(user, action, camera_id | tenant_id)` against a central
  rule set. Store policies in DynamoDB for <10 ms evaluation.
- **Audit:** every mutation writes to CloudWatch Logs plus an
  append-only S3 archive (Object Lock for tamper-evidence). Required
  by most municipal camera contracts.

**Trap to avoid:** baking `tenant_id` into JWT claims only. Tenancy
needs to be a queryable attribute on the session so an admin can
impersonate for support without minting fake tokens.

### 5.2 Camera registry (source of truth)

**Reality at scale:** you cannot manage 1,000 cameras in `.env`. You
need a registry that answers:

- What cameras exist?
- What's each camera's URL, credentials, format (HLS / RTSP / YouTube)?
- Which tenant / territory / geographic area does it belong to?
- What's its current health state, last-seen timestamp, current worker?
- What retention and redaction policy applies (per-jurisdiction)?

**Shape:**
- **DynamoDB** table, one row per camera (~5 KB). GSIs on
  `tenant_id`, `territory_id`, `status`. Writes dominated by heartbeats
  from workers; reads dominated by dashboards.
- **Secrets Manager** stores RTSP passwords and per-camera API keys;
  each DynamoDB row references them by ARN. Workers fetch on
  camera-claim, cache in memory with 1h refresh — never on every frame.
- **Admin UI** with CRUD, bulk CSV import, connection test, territory
  assignment, retire/unretire. A week of frontend work that saves
  months of operational pain: "add a camera" is a one-action operation,
  not a deploy.

### 5.3 Ingestion: GPU worker fleet with lease-based sharding

**Reality at scale:** perception must scale horizontally, workers will
die, and cameras must be reassigned automatically with no operator
intervention.

```
    ┌─────────── EKS or ECS service ──────────────┐
    │                                              │
    │   worker-0    worker-1    worker-2   ...     │
    │   (g5.xl)     (g5.xl)     (g5.xl)            │
    │      │           │            │              │
    │      └── claims ─┼── claims ──┘              │
    │                  ▼                           │
    │         DynamoDB lease table                 │
    │ (camera_id → worker_id, expires_at TTL)      │
    └───────────────────────────────────────────────┘
             │
             │ publishes events
             ▼
        Event bus (MSK / Kinesis)
```

**Worker sizing:** one `g5.xlarge` (1× NVIDIA A10G, 24 GB VRAM) runs
YOLOv8s at ~300 fps aggregate → ~40 cameras at 2 fps with headroom. For
1,000 cameras: **~30 workers**, autoscaled between 20 (off-peak) and 50
(peak / failure recovery).
Instance cost: 30 × g5.xlarge × $1.006/hr × 730 hr/month ≈ $22k/month
on-demand, ~$11k/month with a 3-year reserved commitment.

**Lease table:** one DynamoDB row per camera with `worker_id` and
`expires_at` (TTL ~30s). Workers refresh leases every 10s and claim
expired leases via conditional writes. If a worker dies, its leases
expire and surviving workers pick them up within one TTL. This is the
HA primitive — no external scheduler, no control-plane service to run.

**Why leases, not a central scheduler?** A central scheduler is simpler
at 10 cameras and much harder at 1,000: the coordinator becomes the
single point of failure, and every scheduling decision is a network
round-trip. Optimistic leasing gives the same guarantees with no
control plane.

**Alternative — fully-managed video pipelines:**

| Option | Trade-off |
|---|---|
| **Kinesis Video Streams + SageMaker** | Fully managed ingest. But: SageMaker endpoints are expensive at sustained 2,000 fps, and per-invocation pricing kills you. Tracking state between invocations is awkward. |
| **Roll your own on EKS** (recommended) | More ops work upfront; ~3–5× cheaper and keeps tracking state in-process. The standard choice at this scale. |

### 5.4 Event bus and fan-out

**Reality at scale:** every event needs to go to five places —
persistent storage, LLM enrichment, Slack / PagerDuty routing, the
operator SSE stream, and metrics. Doing that in-process inside the
perception worker couples lifecycles and prevents independent scaling.

| Option | Trade-off |
|---|---|
| **MSK (managed Kafka)** | 3-broker `kafka.m5.large` ≈ $400/month. Partition by `camera_id` for ordering. 7-day retention for consumer replay. Standard choice. |
| **Kinesis Data Streams** | AWS-native, simpler ops. Per-shard limits bite past ~50k events/sec (fine here). Cheaper at low volume, more expensive at peak burst. |
| **SNS → SQS fanout** | Simplest. No ordering or replay — fine for Slack, not for LLM enrichment where retries matter. |

**Recommendation:** MSK, partitioned on `camera_id` so all events for
one camera arrive in order on one consumer. 7-day retention so
consumers can be upgraded safely.

**Consumer pools** (each independently autoscaled):

- **Storage writer** → DynamoDB (hot tier) + Aurora Postgres (warm) +
  S3 Parquet via Firehose (cold).
- **LLM enricher** → Anthropic API; enriched results republished to
  `events.enriched`. Per-tenant rate limits.
- **Notification router** → Slack / PagerDuty by risk level +
  territory.
- **SSE bridge** → gateway tier subscribes, pushes to connected
  operator tabs.

### 5.5 Storage tiers

**Reality at scale:** one database cannot serve both sub-50 ms
dashboard queries *and* 7-year retention. Tier by access pattern.

| Tier | Store | Retention | Purpose | Est. cost |
|---|---|---|---|---|
| **Hot events** | DynamoDB, partition by `camera_id` | 48 h | Dashboard, live queue, recent-history API | ~$300/mo |
| **Warm events** | Aurora Postgres (+ read replica) | 90 d | Incident review, operator queries, reports | ~$600/mo |
| **Cold events** | S3 Parquet (daily partitions) + Athena | 7 years | Legal, DSAR, compliance, ML training | ~$100/mo |
| **Thumbnails** | S3 + CloudFront + lifecycle-delete at 30 d | 30 d | UI display, Slack previews, LLM inputs | ~$100/mo |
| **Audit log** | CloudWatch Logs + S3 archive (Object Lock) | 7 years | Who-did-what forensics | ~$200/mo |

**ETL glue:** a Firehose subscription on the event bus writes Parquet
to S3 continuously; a nightly Lambda promotes hot → warm and ages
warm → cold. No batch jobs, no cron drama.

**Thumbnail flow** (same shape as the original POC write-up, now at
scale):

1. Perception worker calls `s3_client.put_object(...)` after redaction.
2. API returns a CloudFront-signed URL (15-min TTL) to the dashboard.
3. S3 lifecycle rule enforces the 30-day cap; no Python cron.

### 5.6 Live video delivery

**Reality at scale:** the POC's MJPEG-from-Python pattern collapses past
a handful of concurrent viewers — each viewer consumes perception CPU.
That's a resource leak from the UI tier straight into the inference
tier.

**Production shape:**

- Perception workers **do not** serve live video. They publish
  annotated frames to `latest/{camera_id}.jpg` (object key updated
  2×/sec).
- A separate **media tier** (AWS IVS or an nginx-RTMP fleet) transmuxes
  upstream HLS and serves HLS chunks via CloudFront. Operators load a
  standard HLS player — zero custom transport.
- For low-latency overlays in incident-response UIs, a dedicated
  WebRTC signaling service streams annotated frames from a small
  worker pool. Reserved for the few operators who need sub-second
  latency because it's expensive.

**Cost anchor:** IVS is ~$1.20/hour of viewed stream + $0.05/hour of
input. 100 concurrent viewers × 8 hrs/day ≈ $25k/month at typical
usage. A self-hosted nginx-RTMP fleet runs ~$3k/month but adds real ops
burden.

### 5.7 Split UI from backend

Same principle as small-scale production (S3 + CloudFront, CORS on the
gateway tier). At 1,000 cameras the gateway itself is a meaningful
pool — 5–10 Fargate tasks behind an ALB, autoscaled on **operator
count**, not camera count. SSE connections are long-lived; size on
`(operators × avg_open_tabs)` and budget for connection drain during
deploys.

### 5.8 Graceful startup and shutdown, per worker

At 1,000 cameras the POC's "wait for all streams before becoming
healthy" pattern would never pass — some cameras are always failing.
The production contract:

- **Health check = "is this worker claiming and refreshing its
  leases?"** Not "are all its streams connected?".
- Per-camera state is surfaced via the lease table and a worker-local
  `/internal/cameras` endpoint for ops tooling.
- On SIGTERM, the worker releases all leases (deletes lease rows),
  drains in-flight frames, flushes events to the bus, then exits.
  Other workers pick up the orphaned cameras within one lease TTL
  (~30s).

### 5.9 Observability at scale

At 1,000 cameras, a per-camera dashboard is not a dashboard — it's a
wall. You need aggregation and exceptions-only views:

- **Fleet metrics** — aggregate fps, error rate, p50/p99 inference
  latency, cameras-offline count, event rate by risk level. Managed
  Prometheus (AMP) + Grafana Cloud.
- **Per-tenant SLO dashboards** — each tenant sees only their own
  cameras. Grafana with row-level access filters against `tenant_id`
  label.
- **Distributed tracing** — OpenTelemetry at 1% baseline sampling
  across gateway → bus → consumers; 100% sampling on error paths.
  Honeycomb or X-Ray.
- **Alert routing** — camera-down-15-min is a tenant alert (Slack);
  bus-lag-60s is an SRE alert (PagerDuty). Different severities,
  different escalation paths.

Budget: ~$1,500/month for Grafana Cloud + Honeycomb at this fleet
size, or ~$800/month self-hosted on a small EKS add-on.

### 5.10 Abuse protection and tenant isolation

- **WAF** in front of the gateway — managed rule sets for bots, SQLi,
  XSS. ~$10–30/month + per-request.
- **Per-tenant rate limits** — API Gateway usage plans or slowapi
  keyed by tenant. Prevents one tenant's runaway client from starving
  others.
- **Per-tenant LLM budget** — daily token budget in DynamoDB, checked
  before each Anthropic call. Cuts off runaway spend when a tenant
  mis-configures and tries to enrich every low-risk event.

### 5.11 Cost model (indicative, $/month)

| Line item | Estimate |
|---|---|
| GPU perception fleet (30 × g5.xlarge, 3-yr RI) | $11,000 |
| Gateway + consumer Fargate pools | $800 |
| MSK (3 brokers) | $400 |
| DynamoDB (leases + hot events + tenant config) | $500 |
| Aurora Postgres (warm tier) | $600 |
| S3 + CloudFront (thumbs + cold events) | $400 |
| Secrets Manager | $100 |
| Observability (Grafana Cloud + Honeycomb) | $1,500 |
| Live video delivery (IVS, moderate viewership) | $5,000 |
| LLM enrichment (high-risk only, ~5k events/day) | $2,500 |
| WAF + ancillary | $500 |
| **Total** | **~$23,000/month** |

**Sensitivity:**

- Enrich **every** event with LLM (not just high-risk): **+$20k/mo**.
- Live video to every operator tab all day: **+$20–25k/mo** (IVS).
- Cross-region active/active: **+40–60%** across the board.
- Switch GPU fleet to on-demand (no RI commitment): **+$11k/mo**.

These are the big levers. Most other line items are rounding errors.

### 5.12 Failure modes that actually happen at this scale

Roughly in the order they'll page you:

1. **Cameras go offline constantly.** Public YouTube IDs change,
   municipal RTSP endpoints rotate credentials, cell-modem cameras
   flap. At 1,000 cameras, ~50 are always broken. Must be **normal**,
   not alertable. Alert on fleet-wide offline-rate **anomaly**, not
   individual cameras.
2. **LLM rate-limit storms** during event spikes. Implement token
   buckets, queue overflow, and graceful degradation — drop enrichment,
   keep the raw event.
3. **MSK consumer lag** on the enricher when the LLM is slow.
   Autoscale the enricher pool on **consumer lag**, not CPU.
4. **Lease-table hotspots** if partitioning is wrong. Always partition
   the lease table on `camera_id` hash, never on timestamp or
   `tenant_id`.
5. **Thumbnail S3 503s** during event storms. Exponential backoff +
   a local spill queue on worker ephemeral disk; drain on recovery.
6. **Secrets Manager throttling** during rolling deploys of the
   worker fleet. Cache per-camera secrets in worker memory with 1 h
   refresh; never fetch in the hot path.
7. **Cross-tenant data leakage via MJPEG URL guessing** — the POC's
   `/admin/video_feed/{id}` has no tenant check. Adding that check is
   small but mandatory before multi-tenant cutover.

---

## 6. Phased build plan: POC → 1,000 cameras

POC → production at this scale is not one project. Sequence matters —
some steps gate later ones. Indicative team: 2–3 engineers full-time.

| Phase | Scope | Duration |
|---|---|---|
| **0 — POC hardening** | Auth (5.1 MVP), UI split (5.7), basic observability (5.9). Single-box deploy, no scale yet. | 3–4 weeks |
| **1 — Storage split + registry** | Camera registry (5.2), storage tiers (5.5), proper startup/shutdown (5.8). Still single-box perception. Supports ~20 cameras. | 4–6 weeks |
| **2 — Perception fleet** | Worker service + lease table (5.3), event bus (5.4), claim/drain lifecycle. Supports 100+ cameras. | 6–8 weeks |
| **3 — Live video split** | Media tier (5.6), scale gateway tier independently. Supports full operator load. | 3–4 weeks |
| **4 — Multi-tenant + abuse protection** | Tenant-scoped auth (5.1 full), per-tenant rate + LLM budgets (5.10), per-tenant SLO dashboards (5.9). | 3–4 weeks |
| **5 — Scale to 1,000 + multi-region** | Autoscaling tuning, cross-region replication for registry and cold storage, DR drill, chaos testing. | 4–6 weeks |

**Total calendar time:** ~6 months at 2–3 FTE. Plan for 8–10 months
for a first-time team doing it cautiously.

**Anti-patterns to avoid:**

- **Skipping the camera registry** because `.env` feels simpler — past
  50 cameras, the file can't be kept in sync and every deploy becomes
  a camera-config change.
- **One Postgres for hot + warm queries** — the p99 on warm queries
  will eat hot-query headroom.
- **Serving live video from perception workers** — resource leak
  straight into the inference tier; the first thing that breaks at
  30+ concurrent viewers.
- **Enriching every event with LLM** — ~90% of events don't need it,
  and at 1,000 cameras the enrichment bill dwarfs the infrastructure
  bill if you don't gate it.
- **Central scheduler instead of leases** — becomes the failure you
  actually experience.

---

## 7. Quick reference

| I want to… | Command |
|---|---|
| Run the app (POC) | `make start` |
| Stop it | Ctrl+C |
| Run as a reviewer would (no Python env) | `make docker-up` |

---

## 8. Access model reminder

This codebase has **no authentication**. Every API route is open. It
is a POC.

- Safe to expose on `localhost` or a VPN.
- **Not** safe to expose on the public internet without Section 5.1
  in place.

Audit logging still runs; see [road_safety/compliance/](../road_safety/compliance/).
