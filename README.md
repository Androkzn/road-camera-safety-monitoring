# Road Safety

Real-time dashcam safety system. Pulls a live camera stream, detects pedestrian-vehicle and vehicle-vehicle proximity events with YOLOv8 + ByteTrack, narrates each incident with Claude, and exposes an operator copilot with RAG over a statute/policy corpus.

Model-agnostic LLM layer (Anthropic + Azure OpenAI failover), event metadata as the product surface, CV as a pluggable upstream.

---

## Quick start

```bash
git clone <repo-url> && cd <repo-name>
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env          # configure ROAD_STREAM_SOURCE + API keys
python start.py               # runs tests → starts server → opens browser
```

First run downloads `yolov8n.pt` (~6 MB) automatically.

## Run with Docker

```bash
docker compose up --build      # builds + starts on port 8000
```

## Project structure

```
road_safety/                   # installable Python package
  config.py                    # centralized env vars, paths, constants
  server.py                    # FastAPI app — SSE, MJPEG, REST endpoints
  core/
    detection.py               # YOLOv8 + ByteTrack pipeline
    stream.py                  # live video capture (YouTube/RTSP/HLS/mp4)
    egomotion.py               # optical-flow ego-motion compensation
    context.py                 # scene classification (highway/urban/parking)
    quality.py                 # perception quality monitoring
  services/
    llm.py                     # LLM narration, vision enrichment, RAG chat
    llm_obs.py                 # token cost, latency, error observability
    agents.py                  # AI agents (coaching, investigation, report)
    registry.py                # multi-vehicle registry + driver scoring
    drift.py                   # precision monitoring + active learning
    redact.py                  # PII redaction (faces, plates, hashing)
    digest.py                  # tiered Slack digest scheduling
  api/
    feedback.py                # operator verdict submission
  integrations/
    slack.py                   # Slack alerting (Block Kit + tiered digests)
    edge_publisher.py          # edge-to-cloud HMAC-signed event delivery
  compliance/
    audit.py                   # GDPR Art.30 / SOC 2 audit trail
    retention.py               # automated data expiry

cloud/
  receiver.py                  # cloud-side ingest (separate FastAPI app)

tools/
  analyze.py                   # batch mode — process recorded clips
  eval_detect.py               # detection eval harness (precision/recall)
  eval_enrich.py               # LLM enrichment eval

tests/                         # pytest suite (119 tests)
static/                        # operator dashboard + admin UI
docs/                          # architecture, BRD, TRD, implementation spec
start.py                       # one-command launcher
Dockerfile                     # production container
docker-compose.yml             # compose stack
Makefile                       # dev workflow shortcuts
```

## Configuration

All settings are environment-driven. See [`.env.example`](.env.example) for the full list.

| Variable | Required | Description |
|---|---|---|
| `ROAD_STREAM_SOURCE` | Yes | Video source URL (YouTube/RTSP/HLS/mp4) |
| `ROAD_VEHICLE_ID` | Yes | Vehicle identifier |
| `ROAD_ID` | Yes | Road/route identifier |
| `ROAD_DRIVER_ID` | Yes | Driver identifier |
| `ANTHROPIC_API_KEY` | No | Enables LLM narration + copilot chat |
| `SLACK_WEBHOOK_URL` | No | Enables Slack alerting |
| `ROAD_PLATE_SALT` | Recommended | Plate hash salt (auto-generated if unset) |

## Architecture

```
Live stream (YouTube/HLS/RTSP/mp4)
    │
    ▼
stream.py  ──►  StreamReader (background thread, configurable FPS)
    │
    ▼
detection.py ──► YOLOv8 + ByteTrack ──► TTC / distance ──► typed events
    │
    ▼
server.py  ──► egomotion.py (optical flow) + context.py (scene adaptive)
  │              + quality.py (perception gating) + redact.py (PII)
  │
  ├─► SSE    /stream/events       real-time event push
  ├─► MJPEG  /admin/video_feed    annotated video stream
  ├─► POST   /chat                RAG copilot (corpus + live events)
  ├─► GET    /api/live/*          status, events, scene, perception
  ├─► GET    /api/drift           precision monitoring
  ├─► GET    /api/road/*          multi-vehicle aggregation
  ├─► GET    /api/llm/*           LLM cost/latency observability
  ├─► GET    /api/audit           compliance audit trail
  └─► POST   /api/agents/*        AI coaching, investigation, reports
```

## Key design decisions

- **Scene-adaptive thresholds** — highway / urban / parking classification adjusts TTC and distance bands dynamically.
- **Ego-motion compensation** — optical flow separates camera motion from object motion.
- **Episode model** — groups detections of the same track pair into episodes, emits only peak-severity moment.
- **Dual-thumbnail PII redaction** — internal (unredacted, local-only) vs public (face + plate blurred) for all external paths.
- **Token-bucket + circuit breaker** on LLM calls — prevents rate limiting and cascading failures.
- **Edge/cloud split** — perception runs on-device, only typed JSON + redacted thumbnails cross the wire.
- **Drift monitoring** — rolling precision from operator feedback, with active learning for model improvement.

## API reference

| Endpoint | Method | Description |
|---|---|---|
| `/stream/events` | GET | SSE live event feed |
| `/admin/video_feed` | GET | MJPEG annotated video stream |
| `/admin/detections` | GET | SSE per-frame detection snapshots |
| `/chat` | POST | RAG copilot chat |
| `/api/live/status` | GET | System status + perception state |
| `/api/live/events` | GET | Recent events (filterable) |
| `/api/live/scene` | GET | Scene context + adaptive thresholds |
| `/api/drift` | GET | Rolling precision + trend |
| `/api/feedback` | POST/GET | Operator verdict submission |
| `/api/coaching_queue` | GET | Pending medium-risk events |
| `/api/active_learning/export` | POST | Export samples for labeling |
| `/api/road/summary` | GET | System-wide aggregation |
| `/api/road/vehicle/{id}` | GET | Per-vehicle stats + score |
| `/api/road/drivers` | GET | Driver safety leaderboard |
| `/api/agents/coaching` | POST | AI coaching note generator |
| `/api/agents/investigation` | POST | AI event investigation |
| `/api/agents/report` | POST | AI safety summary report |
| `/api/llm/stats` | GET | LLM cost, latency, error rates |
| `/api/audit` | GET | Compliance audit trail |
| `/api/retention/sweep` | POST | Trigger data retention sweep |
| `/api/admin/health` | GET | Detailed server health check |

## Testing

```bash
make test                      # or: pytest tests/ -v
```

119 tests covering core detection pipeline, services, API routes, compliance, and integrations.

## License

MIT — see [LICENSE](LICENSE).
