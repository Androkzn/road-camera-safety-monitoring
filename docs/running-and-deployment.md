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
> pipeline end-to-end, not to survive a production SLA. Section 5
> explains what you'd change and why.

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

## 5. Production setup — what's missing and how to add it

A production deployment needs a different shape than the POC. Here's
what's missing, ranked roughly by criticality, with concrete options
and trade-offs for each.

### 5.1 Authentication (show-stopper)

**Missing:** every API route is open. Anyone who can reach the URL can
read events, change settings, export data, stream live video.

**Options:**

| Option | Effort | Trade-off |
|---|---|---|
| **Cognito User Pool + ALB auth listener** | 1–2 days (config only, no code) | AWS-native, integrates with ALB out of the box, supports social / SAML / OIDC. Tied to AWS. |
| **API Gateway authorizer** | 2–3 days | Works for JSON APIs; awkward for SSE and MJPEG long-lived connections. |
| **Homegrown JWT + bcrypt users** | ~1 week | Portable, no AWS lock-in. But: you own password rotation, MFA, session management. Rarely worth it. |
| **OAuth2 via Auth0 / Clerk / WorkOS** | 2–3 days | Cleanest UX for enterprise SSO. Adds a per-seat vendor cost. |

**Recommendation:** Cognito for AWS-hosted deployments. The ALB auth
listener does the redirect dance without any Python code change — you
just tell FastAPI to trust the `x-amzn-oidc-identity` header the ALB
injects.

### 5.2 Stateful storage (mandatory for HA and scaling)

**Missing:** SQLite in `data/settings.db`, thumbnails in
`data/thumbnails/`, event logs in `data/*.jsonl`. Fargate containers
have ephemeral filesystems — all of this evaporates on restart, and
nothing is shareable between two tasks.

**Demo vs. production at a glance:**

| State | POC (what this build does) | Production (what you'd do) |
|---|---|---|
| Settings | SQLite file on local disk | **RDS Postgres** (managed, multi-AZ capable) |
| Thumbnails | Local disk, swept hourly via `ROAD_RETENTION_THUMBNAILS_DAYS=0` | **S3** (object store) + **CloudFront** (CDN) + **lifecycle policy** (auto-delete after N days) |
| Event log | JSONL file on local disk | **CloudWatch Logs** (captured from stdout) |
| Audit log | JSONL file on local disk | **CloudWatch Logs** + optional long-term archive to S3 |

The POC "sweep every hour" trick (Section 2 "Thumbnail retention")
keeps the disk from filling up but is fundamentally the wrong model
for production — it still hits a single ephemeral disk, still can't
be shared across tasks, still vanishes on restart. The real fix is
**object storage**, not aggressive cleanup.

**Options per piece of state:**

**Settings DB:**
| Option | Trade-off |
|---|---|
| **RDS Postgres** (single AZ `db.t4g.small`) | Default choice. Low cost, reliable. One Python driver change. |
| **Aurora Serverless v2** | Scales to zero when idle; better for spiky workloads. Higher per-hour cost when active. |
| **DynamoDB** | Managed, scales automatically, cheap at rest. But: no SQL — you'd rewrite the settings layer from tables to a key-value model. |

**Thumbnails:**
| Option | Trade-off |
|---|---|
| **S3 + CloudFront + pre-signed URLs** | Obvious choice. Durable, cheap, CDN-fronted. See note below. |
| **EFS mount** | Looks like a filesystem to Python (minimal code change) but ~10× more expensive than S3 and still single-region. |
| **Aggressive retention only (what the POC does today)** | Zero new infra. But: still ephemeral, still per-task, still no CDN. Only useful for demos. |

> **How production thumbnail storage actually works:**
>
> 1. When an event fires, the redaction writer calls
>    `s3_client.put_object(Bucket=..., Key=f"thumbs/{event_id}.jpg", Body=jpeg_bytes)`
>    instead of `Path.write_bytes(...)`.
> 2. The dashboard asks the API for a thumbnail URL; the API returns a
>    **pre-signed URL** valid for ~15 minutes (time-limited, scoped to
>    that one object).
> 3. The browser loads the image through **CloudFront**, which caches
>    it at the edge. Second operator to view the same event = cache hit,
>    no round-trip to S3.
> 4. Retention becomes an **S3 lifecycle rule**: "delete objects under
>    `thumbs/` prefix after 30 days" — enforced by S3 itself, zero
>    Python code.
>
> **Cost math:** 100 cameras × 30 days ≈ 285 GB in S3. At
> $0.023/GB/month that's **~$7/month**. CloudFront egress depends on
> how often operators view events, but the cache hit rate is usually
> >80% so bandwidth bills are minimal.

**Event log:**
| Option | Trade-off |
|---|---|
| **CloudWatch Logs** (from stdout) | Free with Fargate. Query via Logs Insights. Good for most operations. |
| **OpenSearch** | Better for long-retention + complex queries. Adds real cost (~$100/month minimum). |
| **S3 + Athena** | Cheapest for years-long retention. Slower queries. |

**Recommendation:** RDS Postgres + S3 + CloudWatch. Straightforward,
cheap, and the code change is mostly swapping two modules.

### 5.3 Separate the React UI from the backend

**Missing:** the UI ships from the same uvicorn process that runs
perception. Every UI deploy restarts perception. Every perception
restart drops active video streams for ~70 seconds.

**Options:**

| Option | Effort | Trade-off |
|---|---|---|
| **S3 + CloudFront** | 1 day | Standard static-site deploy. CDN caching. Independent release cadence. Frontend deploys in ~30s instead of 5min. |
| **Amplify Hosting** | Half a day | AWS's managed front-door for SPAs. Has PR previews out of the box. A bit more expensive and more vendor-tied. |
| **Vercel / Netlify** | Half a day | Best UX for pure frontend. Bills per seat. Not AWS-native so data-transfer paths get weird. |

**Trade-off to understand:** splitting the UI requires adding **CORS**
support to the backend (so the React app at `https://app.example.com`
can call the API at `https://api.example.com`). That's ~10 lines of
FastAPI middleware. You also need a build-time env var
(`VITE_API_BASE_URL`) so the bundle knows where to call.

**Recommendation:** S3 + CloudFront. Cheapest, most flexible, and it's
the path that unlocks clean Cognito auth later.

### 5.4 Graceful startup and shutdown

**Missing:**

- **Startup is all-or-nothing.** The lifespan hook waits for every
  camera to connect (~70s for 6 YouTube feeds) before the app answers
  `/api/admin/health`. During that window, ALB marks the task
  unhealthy, rolling deploys drop traffic, autoscaling can't respond.
- **Shutdown leaks child processes.** On SIGTERM, yt-dlp / ffmpeg
  subprocesses survive, pipe-break messages flood, and the task
  doesn't drain cleanly.

**Options:**

**For startup:**
| Option | Trade-off |
|---|---|
| **Lazy camera init + per-camera readiness flag** | App becomes healthy in ~2s; cameras attach in background. `/api/live/sources` exposes per-camera state. Clean, correct. ~1 day of work. |
| **Accept 70s startup + increase ALB start-period** | Zero code change. But rolling deploys still drop traffic, and autoscaling can't respond quickly. Not really a fix, just hiding the problem. |

**For shutdown:**
| Option | Trade-off |
|---|---|
| **Lifespan shutdown hook that kills subprocesses** | Handle SIGTERM → close stream readers → `proc.terminate()` each subprocess → `proc.wait(timeout=5)` → `kill()`. ~half a day. The right fix. |
| **Container stop grace period extended to 60s** | Zero code change. Tasks take a minute to die. Deploys get slower. Partial workaround. |

**Recommendation:** do both real fixes (lazy init + proper shutdown).
Combined effort ~1.5 days. Big quality-of-life improvement for ops.

### 5.5 Horizontal scaling

**Missing:** the app is one process. Past ~10 cameras it starves; past
one Fargate task you have no way to partition cameras across
instances.

**Options:**

| Option | Effort | Trade-off |
|---|---|---|
| **Vertical scale (bigger Fargate task)** | Half a day | Go from 2 vCPU → 16 vCPU. Gets you to maybe 20 cameras. No HA. Eventually hits a ceiling. |
| **Manual partitioning via env vars** | 1 day | `ROAD_STREAM_SOURCE_SHARD=0/3` splits cameras by hash. Works, but requires hand-editing env vars when camera count changes. |
| **Split into gateway + worker tiers with leases** | 1–2 weeks | The real answer. Gateway handles UI / API / SSE (stateless, autoscales on user load). Workers claim cameras via DynamoDB lease table (autoscale on camera count). Redis pub/sub glues events. |
| **GPU fleet for perception** | +1 week | g4dn.xlarge fits ~20–40 cameras per T4 GPU. g5.xlarge fits ~40–80 on an A10G. Only matters past ~25 cameras; below that CPU Fargate is fine. |

**Trade-off to understand:** the worker/gateway split solves real
problems (independent scaling, per-worker blast radius, rolling deploys
that don't drop video) but adds real complexity (lease stale-detection,
pub/sub delivery gaps, MJPEG transport that can't round-trip through
Redis cheaply). Don't do it past a certain camera count — but don't do
it before.

**Recommendation:** stay on the monolith until camera count forces it.
Rule of thumb: split when you hit 20+ cameras, or when a single
perception-tier restart dropping video for 70s becomes operationally
intolerable.

### 5.6 Observability

**Missing:** logs via stdout are the only telemetry. No metrics, no
traces, no per-camera health.

**Options:**

| Option | Effort | Trade-off |
|---|---|---|
| **Prometheus `/metrics` endpoint via `prometheus-fastapi-instrumentator`** | Half a day | Industry standard. Auto-captures request counts, latency histograms, errors. Scrape via CloudWatch Agent. |
| **OpenTelemetry + AWS X-Ray** | 2–3 days | Distributed traces. Worth it when you split into multiple tiers (Section 5.5). Overkill for a monolith. |
| **CloudWatch Embedded Metric Format (EMF) in logs** | 1 day | Emit metrics as structured JSON lines; CloudWatch extracts them. No new endpoint needed. Locked to AWS. |

**Recommendation:** Prometheus endpoint first — one library import and
a mount. Add OpenTelemetry later if/when you split tiers.

### 5.7 Abuse protection

**Missing:** no rate limiting on API endpoints (there's a narrow
per-IP limiter for clip rendering, but nothing else). No WAF.

**Options:**

| Option | Effort | Trade-off |
|---|---|---|
| **AWS WAF rules in front of ALB** | 1 day | Managed rule sets for bots, SQL injection, etc. Billed per rule per million requests. The right place for this. |
| **FastAPI-level rate limit (slowapi)** | Half a day | Per-IP or per-key rate buckets in Python. Fine for finer-grained rules, but doesn't protect against floods that overwhelm the task. |
| **CloudFront + `AWS-AWSManagedRulesCommonRuleSet`** | Half a day | Free tier for common attack patterns. Catches the worst stuff for zero effort. |

**Recommendation:** CloudFront managed rules (free) + WAF rate-based
rule (~$10/month). Add slowapi in Python only if you need
per-authenticated-user budgets.

---

## 6. Recommended production path (priorities in order)

If someone asked "do these in order, with minimal scope creep":

1. **Split UI to S3 + CloudFront** (Section 5.3) — ~1 day, unlocks
   everything else.
2. **Add Cognito auth** (Section 5.1) — mandatory before any external
   exposure.
3. **Move state to RDS + S3** (Section 5.2) — required before running
   more than one task.
4. **Fix startup and shutdown** (Section 5.4) — required for zero-
   downtime deploys.
5. **Add Prometheus metrics** (Section 5.6) — enables smart
   autoscaling later.
6. **Add WAF + CloudFront managed rules** (Section 5.7) — cheap
   insurance.
7. **Split perception workers only when camera count forces it**
   (Section 5.5).

Total effort for items 1–6: **~2 weeks** of focused work for one
engineer. That's the path from POC to a credible small-scale
production deployment (≤25 cameras, one region, one operator team).

Item 7 is a larger rewrite that only pays off past 20–30 cameras.

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
