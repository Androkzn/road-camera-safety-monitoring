# Running the App: Local, Docker, Production

This doc explains where the app runs, what the entry points are, and how
the local setup maps onto a real production deployment on AWS. It is
written for someone who is new to Python and the project.

---

## 1. The mental model

The codebase ships **two separate FastAPI apps**:

| App | What it does | Entry point (Python path) | Port |
|---|---|---|---|
| **Edge app** | Perception pipeline + live admin UI. Reads camera frames, runs YOLOv8, emits events. | `road_safety.server:app` | `8001` (local), `8000` (Docker default) |
| **Cloud receiver** | HMAC-verified ingest endpoint + SQLite store. Receives events from edge nodes. | `cloud.receiver:app` | `8001` (Docker profile) |

In **production**, these run on different machines:

- The **edge app** runs in the vehicle, on a small Linux computer next to the camera.
- The **cloud receiver** runs in AWS.

In **local dev**, you almost always run just the edge app on your Mac. The
cloud receiver is optional, only needed if you're testing the edge→cloud
handoff.

> "FastAPI app" means a Python object — the variable `app` inside
> `road_safety/server.py` or `cloud/receiver.py`. It's the web application
> itself. A web server process (uvicorn) loads this object and listens on
> a port.

---

## 2. What is the "entry point"?

There isn't one entry point — there are **three layers**, and which one
you use depends on whether you're developing, demo'ing, or deploying.

### Layer 1 — `start.py` (dev launcher)

`start.py` is a convenience script. It:

1. Builds the React frontend (`npm run build` → `frontend/dist/`).
2. Runs the pytest suite (optional).
3. Launches uvicorn pointing at `road_safety.server:app`.
4. Waits for `/api/live/status` to return `200`.
5. Opens the admin UI in your default browser.

This is what the Makefile targets `make run` and `make start` call under
the hood. It exists so a new developer doesn't have to memorize the
uvicorn invocation.

**Used by:** developers, only.

### Layer 2 — `road_safety.server:app` (the actual FastAPI app)

The line `app = create_app()` at `road_safety/server.py:190` is the real
entry point. Everything else (start.py, Docker, uvicorn flags) is just a
way to get a uvicorn process that loads this object.

If you strip everything away, the minimum command to run the app is:

```bash
.venv/bin/python -m uvicorn road_safety.server:app --port 8001
```

**Used by:** uvicorn, Docker, any production runtime.

### Layer 3 — the OS-level process (uvicorn)

`uvicorn` is the actual process that binds the port and runs the Python
async event loop. Think of it as "the web server". uvicorn loads
`road_safety.server:app` and serves it over HTTP.

**Used by:** everything — uvicorn is always the process that actually
runs. `start.py` / Docker / the Makefile are all just different ways of
spawning it.

### Visual summary

```
    make start        ┐
    make run          ├─► start.py ──► uvicorn ──► road_safety.server:app
    python start.py   ┘
                                                         ▲
    docker compose up ──► (container) ──► uvicorn ──────┘
                                                         ▲
    make dev-hot ──────► uvicorn --reload ───────────────┘
```

All roads lead to `uvicorn → road_safety.server:app`.

---

## 3. Running locally (the options)

### Option A — `make start` (recommended, with logs)

```bash
make start
```

Foreground. Logs stream to your terminal. Ctrl+C stops. Serves the
production-built React bundle from `frontend/dist/`. No hot-reload.

**Use this** when you just want to see the app working.

### Option B — `make dev-hot-lite` (hot reload, fast)

```bash
make dev-hot-lite
```

Two processes launched together:

- **uvicorn with `--reload`** on port `8001`. Restarts the backend when
  you save a `.py` file.
- **Vite dev server** on port `3000`. Hot-patches the frontend when you
  save a `.tsx` / `.ts` / `.css` file.

Opens at `http://localhost:3000`. Vite proxies API calls to `127.0.0.1:8001`.

Overrides `ROAD_STREAM_SOURCES=''` so the app uses bundled MP4 clips
instead of live YouTube streams → startup in ~2 seconds instead of ~70.

**Use this** for daily development.

### Option C — `make dev-hot` (hot reload, real streams)

Same as `dev-hot-lite` but respects your `.env` — so it uses the YouTube
streams configured there. Startup takes ~70 seconds because each
`yt-dlp` + `ffmpeg` pipe has to negotiate with YouTube.

**Use this** only when you're specifically testing live-stream
ingestion.

### Option D — `make start-bg` (background, logs to file)

```bash
make start-bg   # detach, write logs to .road_safety.log
make logs       # tail the logs
make stop       # kill it
```

Use for demos where you want the server running while you do other
things in the terminal.

### Option E — bare uvicorn (no magic)

```bash
.venv/bin/python -m uvicorn road_safety.server:app --host 127.0.0.1 --port 8001
```

This is what all the other options call under the hood. Useful for
understanding what's happening; not what you use day-to-day.

---

## 4. Where does it actually run?

Always on **your Mac** in all local modes (A–E). None of these touch the
cloud.

### Where does data live?

- **Compiled frontend:** `frontend/dist/` (created by `npm run build`).
  The FastAPI process serves these HTML/JS files statically.
- **Thumbnails, DB, logs:** `data/` directory. Created on first run.
- **Models (YOLOv8 weights):** `yolov8s.pt`, `rtdetr-l.pt` at the repo
  root. Auto-downloaded on first run.
- **Config:** `.env` (your local secrets) + environment-variable
  defaults in `backend/config.py`.

### What ports?

| Port | What |
|---|---|
| `8001` | Edge app (FastAPI + bundled React) |
| `3000` | Vite dev server (only in `dev-hot-lite` / `dev-hot`) |
| `8001` (Docker) | Cloud receiver, only if you start it with `--profile cloud` |

> Port conflict note: if you run `make dev-hot-lite` AND `docker compose
> --profile cloud up`, both want `8001`. Pick one or change the
> `ROAD_CLOUD_PORT` env var for Docker.

---

## 5. Docker

The repo has a `Dockerfile` and a `docker-compose.yml`. They are for
production-style runs and for reviewers who don't want to install Python
locally.

### Dockerfile summary

```dockerfile
FROM python:3.12-slim
RUN apt install libgl1 libglib2.0-0 ffmpeg
COPY pyproject.toml → pip install
COPY backend/ cloud/ static/ data/corpus/ start.py
EXPOSE 8000
CMD uvicorn road_safety.server:app --host 0.0.0.0 --port 8000
```

Note: the Dockerfile does **not** build the frontend. It expects
`static/` to contain a pre-built bundle (or the app falls back to that
when `frontend/dist/` is absent). For a real container deploy you'd
either build the frontend inside Docker (multi-stage) or bake the
existing `frontend/dist/` into the image.

### Local container run

```bash
make docker-up              # starts the edge app on :8000
make docker-up-cloud        # adds the cloud receiver on :8001
make docker-down            # stop
```

Or directly:

```bash
docker compose up --build
docker compose --profile cloud up --build
```

Data persists in named volumes (`app-data`, `cloud-data`) so events and
thumbnails survive container restarts.

### When to use Docker vs. native

- **Native Python (`make start`)** — faster startup, easier debugging,
  can use Apple Metal (MPS) for GPU-accelerated YOLO.
- **Docker (`make docker-up`)** — reproducible, matches production,
  doesn't require a working Python env. But perception runs on CPU
  inside the container (no MPS passthrough), so detection is slower.

For dev work on a Mac: use native. For sharing with someone who doesn't
have a Python setup: Docker.

---

## 6. Production on AWS

The **edge app** does **not** run on AWS. It runs on an embedded Linux
computer (typically NVIDIA Jetson) inside each vehicle, next to the
camera. Running perception in the cloud would miss the latency window
for safety-critical decisions and would cost ~1 GB/day per camera in
uplink bandwidth.

Only the **cloud receiver** (`cloud.receiver:app`) goes to AWS. It's a
small FastAPI app that accepts HMAC-signed JSON events from edge nodes.

### Reference architecture

```
  IN EACH VEHICLE                         AWS REGION
  ┌─────────────────────────┐            ┌──────────────────────────────┐
  │  Camera → Jetson        │            │                              │
  │  ├── road_safety.server:app │   HTTPS    │  Route 53 (DNS)              │
  │  │    YOLOv8, tracking  │ ──────────▶│       │                      │
  │  │    PII redaction     │  HMAC-     │       ▼                      │
  │  │    event construct   │  signed    │  ALB (HTTP/2, TLS from ACM)  │
  │  └── edge publisher     │   JSON +   │       │                      │
  │      (queue, retry,     │   thumbs   │       ▼                      │
  │       HMAC sign)        │            │  ECS Fargate                 │
  │                         │            │  └── cloud.receiver:app      │
  └─────────────────────────┘            │       │                      │
                                         │       ├──▶ RDS Postgres      │
                                         │       ├──▶ S3 (thumbnails)   │
                                         │       ├──▶ CloudWatch (logs) │
                                         │       └──▶ SNS → Slack/email │
                                         │                              │
                                         │  Secrets Manager (HMAC key,  │
                                         │    LLM API keys)             │
                                         └──────────────────────────────┘
```

### Mapping local → AWS

| Concern | Local dev | AWS production |
|---|---|---|
| Run the Python app | uvicorn on your Mac | **ECS Fargate** running the Docker image (same container as local) |
| Serve HTTPS + HTTP/2 | plain HTTP on localhost | **ALB** (Application Load Balancer) + **ACM** cert |
| Database | `data/cloud.db` (SQLite) | **RDS Postgres** (Aurora Serverless is a fit for spiky loads) |
| Thumbnails | local disk `data/thumbnails/` | **S3** bucket, private, pre-signed URLs for UI |
| Secrets (`.env`) | local file | **Secrets Manager**, injected as env vars at task start |
| Logs | stdout / `.road_safety.log` | **CloudWatch Logs** (stdout is captured automatically) |
| Metrics | none | **CloudWatch Metrics** + dashboards |
| Alerts (Slack/email) | direct HTTP from Python | keep direct HTTP, or route via **SNS** for fan-out |
| Per-vehicle identity | `.env` vars | **IoT Core** certificates (one per vehicle) |
| Event buffering under spikes | none | **SQS** queue between ALB and Fargate |
| Frontend hosting | served by uvicorn | **S3 + CloudFront** (CDN) serving `frontend/dist/`, calling the API over HTTPS |
| DNS | `localhost` | **Route 53** |

### Minimum-viable AWS deployment steps

For a POC deployment of the cloud receiver only (edge node stays on a
Jetson in the vehicle):

1. **Build and push the container.**
   ```bash
   aws ecr create-repository --repository-name road-safety
   docker build -t road-safety .
   docker tag road-safety:latest <account>.dkr.ecr.<region>.amazonaws.com/road-safety:latest
   docker push <account>.dkr.ecr.<region>.amazonaws.com/road-safety:latest
   ```

2. **Create an ECS cluster + Fargate service** running that image, with
   the command overridden to `uvicorn cloud.receiver:app --host 0.0.0.0
   --port 8001`.

3. **Put an ALB in front** of the service. Attach an ACM certificate
   for TLS. Route only POST `/ingest/events` through it (the receiver's
   only endpoint that matters).

4. **Provision an RDS Postgres instance** and update the receiver to
   use Postgres instead of SQLite (the receiver currently hardcodes
   SQLite; that's the one code change needed).

5. **Store `ROAD_CLOUD_HMAC_SECRET` in Secrets Manager** and reference
   it from the ECS task definition.

6. **Point Route 53** at the ALB, and give each vehicle's edge node the
   DNS name as its `ROAD_CLOUD_ENDPOINT`.

7. **Enable CloudWatch** for the task definition (free; it's just
   stdout capture).

### What does **not** need to change

The app already:

- Listens on `0.0.0.0` when run via the Dockerfile CMD.
- Reads every tunable from environment variables (no hardcoded paths
  outside `backend/config.py`).
- Runs cleanly as a single container with no external runtime
  dependencies beyond the Python stdlib, `ffmpeg`, and `libgl1`.
- Has a `HEALTHCHECK` already defined in the Dockerfile, which ALB
  target groups will consume directly.

So the AWS port is mostly **infrastructure**, not code changes. The
biggest code change is swapping SQLite → Postgres in the cloud receiver
(one module in `cloud/receiver.py`).

---

## 7. Quick reference — which command to use when

| I want to… | Command |
|---|---|
| Run the app and see it work | `make start` |
| Iterate on Python or React with auto-reload | `make dev-hot-lite` |
| Test real YouTube stream ingestion | `make dev-hot` |
| Leave the app running in the background | `make start-bg` + `make logs` / `make stop` |
| Run as a reviewer would (no Python env needed) | `make docker-up` |
| Stop everything | Ctrl+C (foreground) / `make stop` (bg) / `make dev-stop` (dev-hot) |

## 8. Access model reminder

This codebase has **no authentication**. Every API route is open. It is
a POC.

- Safe to expose on `localhost` or a VPN.
- **Not** safe to expose on the public internet without putting an auth
  layer (Cognito, API Gateway authorizer, or equivalent) in front.
- The HMAC on edge-to-cloud ingest authenticates **devices**, not
  humans. It does not protect the admin UI.

Audit logging still runs; see [backend/compliance/audit.py](../backend/compliance/audit.py).
