# Fleet Safety — Live Event Detection + LLM Copilot

A real-time fleet safety dashboard. Pulls a live public camera stream, detects pedestrian-vehicle and vehicle-vehicle proximity events with YOLO, narrates each incident with Claude, and exposes an operator copilot that answers questions over a small statute/policy corpus using RAG.

Model-agnostic LLM layer (Anthropic + Azure OpenAI drop-in), event metadata as the product surface, CV as a pluggable upstream.

## Industry challenges and how we solve them

Fleet safety AI is a hard production problem. Below are the six core challenges the industry faces and how this project addresses each one.

### 1. False positives — the #1 fleet safety AI problem

Basic detection systems generate massive false-positive volumes. Close vehicle proximity is normal in a parking lot but dangerous on a highway. Fixed thresholds either miss real danger at high speed or flood drivers with noise during routine maneuvers. Alert fatigue sets in fast — drivers learn to ignore everything, including valid warnings.

**How we solve it:**

- **Scene-adaptive thresholds** (`context.py`) — classifies the scene as highway / urban / parking using a rolling window of detections and ego-speed, then applies calibrated TTC and distance bands per scene type.
- **Ego-motion compensation** (`egomotion.py`) — optical-flow estimation of camera motion, subtracted from object motion so the vehicle driving forward doesn't masquerade as oncoming closure.
- **Episode model with peak-severity emission** — groups detections of the same track pair into a single episode and emits only the peak-risk moment, preventing alert spam.
- **Quality-adjusted classification** (`quality.py`) — detects degraded perception (low light, blur, overexposure, weak detector confidence) and tightens thresholds so bad frames don't produce false alerts.
- **Operator feedback → drift monitoring** (`drift.py`) — operator TP/FP verdicts feed a rolling precision tracker sliced by risk level and event type so you can see exactly where the model is failing.

### 2. Edge / cloud latency and bandwidth

Real-time safety requires sub-second inference, but edge devices have limited compute. Cloud has power but adds round-trip latency. Bandwidth from hundreds of vehicles simultaneously is expensive — raw dashcam video can exceed 1 GB/day/stream.

**How we solve it:**

- **Edge/cloud split architecture** (`edge_publisher.py` → `cloud_receiver.py`) — heavy perception, PII redaction, and event construction run on-device. Only typed JSON + small redacted thumbnails cross the wire (~500 KB/day vs ~1 GB/day raw).
- **HMAC-signed batched delivery** with exponential backoff and offline-resilient JSONL queue that survives network outages and drains on reconnect (at-least-once, idempotent on `event_id`).
- **Lightweight YOLOv8n** — the nano variant keeps inference fast on CPU.
- **Selective LLM enrichment** — vision calls are skipped for low-risk events and degraded frames, saving both latency and cost.

### 3. LLM reliability in production

80% of RAG failures trace to ingestion, not the model. Hallucination in safety-critical contexts is dangerous. LLM costs compound at fleet scale. Rate limiting and provider outages cause service degradation.

**How we solve it:**

- **Token-bucket rate limiter** — client-side throttle prevents 429s before they happen.
- **Circuit breaker on vision enrichment** — 3 consecutive failures trigger a cooldown period, preventing cascading retries.
- **Self-consistency for ALPR** — 2-sample voting catches plate-read hallucination before it reaches downstream.
- **Injection defense** — image content is treated as untrusted input (OWASP LLM01:2025).
- **Graceful fallback** — when the LLM is unavailable, narration falls back to templated summaries and chat disables cleanly.
- **Multi-provider failover** — Anthropic primary → Azure OpenAI secondary (or vice versa), automatic switchover on provider outage.
- **Prompt-cached RAG corpus** — statute/policy corpus tagged `cache_control: ephemeral` so repeated copilot queries pay ~0 on corpus tokens.
- **Cost and latency observability** (`llm_obs.py`) — per-call token tracking, estimated USD cost, latency p50/p95, error and skip rates broken down by call type and model.

### 4. Privacy and compliance (GDPR / CCPA)

Fleet cameras capture faces, license plates, and location data — all PII. Fines for mishandling can be severe. Plate data creates tracking profiles. External sharing (Slack, LLM providers, cloud dashboards) multiplies the exposure surface.

**How we solve it:**

- **Dual-thumbnail architecture** (`redact.py`) — internal annotated thumbnail (local disk only) vs public redacted thumbnail (all external paths). Redaction runs on the raw frame before any annotation is drawn.
- **Face blurring** — upper 35% of every person bounding box, over-redacting rather than missing.
- **Plate blurring** — lower-middle strip of every vehicle bounding box.
- **Plate hashing** — raw plate text → salted SHA-256 hash. Downstream systems can correlate repeat plates without ever storing the readable string.
- **PII scrub before shared buffers** — `plate_text` and `plate_state` are stripped from any enrichment result before it enters SSE, Slack, or agent context.
- **DSAR-gated access** — unredacted thumbnails require a token; access is audit-logged.
- **Automated data retention** (`retention.py`) — configurable expiry for thumbnails (default 30 days), feedback (90 days), active-learning samples (60 days), and outbound queue (7 days). Background sweep runs hourly.
- **Audit trail** (`audit.py`) — append-only JSONL log of who accessed what, when, with structured action verbs (access, feedback, export, chat, DSAR, retention sweep). Thread-safe, queryable, disableable.

### 5. Model drift and continuous improvement

CV models degrade in production — weather changes, new camera angles, seasonal lighting, fleet expansion to new geographies. Without a feedback loop, precision drops silently.

**How we solve it:**

- **Rolling-window precision** (`drift.py`) — joins operator feedback to events and computes precision over a sliding window, sliced by risk level and event type.
- **Trend detection** — compares current window to the prior window and classifies as improving / stable / degrading, with Slack alerts on precision drops below 0.70.
- **Active learning sampler** — probabilistically queues events near the decision boundary (confidence 0.35–0.50) where labels are most informative, and always queues disputed events (operator verdict = FP).
- **Export for labeling tools** — batches with `manifest.json` compatible with Label Studio / CVAT, so new training data flows back into the model improvement cycle.

### 6. AI agent orchestration

Enterprise AI agent pilots frequently fail to scale. Common causes: tool overload leading to hallucination, lack of observability, and context collapse in multi-step pipelines. Safety workflows — coaching, investigation, reporting — need repeatable, grounded outputs, not open-ended chat.

**How we solve it:**

- **Three focused agents** (`agents.py`), each with a single responsibility and a bounded tool set (< 5 tools):
  - **CoachingAgent** — given a high/medium-risk event, generates a structured coaching note (what happened, why it matters, what the driver should do differently).
  - **InvestigationAgent** — correlates a single event with historical data, fleet policy, and drift reports to build a root-cause narrative.
  - **ReportAgent** — queries events, feedback, and drift data to produce a structured safety summary.
- **Hard iteration cap** (MAX_STEPS = 5) — prevents runaway loops.
- **Structured JSON output** with schema enforcement — outputs are machine-parseable, not free text.
- **Idempotent tool calls** — re-running with the same input produces the same output.
- **Full observability** — agent calls flow through `llm_obs` for cost, latency, and error tracking.

### 7. Fleet-scale operations

Going from a single camera to thousands of vehicles requires per-vehicle state, driver-level accountability, fleet-wide rollups, and tiered alerting that doesn't drown the operations team.

**How we solve it:**

- **Multi-vehicle registry** (`fleet.py`) — per-vehicle event counts by risk and type, safety score (100 baseline with risk-weighted penalties and time-decay recovery), per-vehicle precision from feedback.
- **Driver leaderboard** — merges vehicles by driver ID and ranks by worst safety score for coaching prioritization.
- **Fleet-wide aggregation** — total risk/type counts and automatic identification of the lowest-scoring vehicle.
- **Tiered Slack alerting** (`slack_notify.py`) — high-risk events post immediately with Block Kit and annotated thumbnails; medium-risk events batch into hourly digests; low-risk events into daily summaries. Keeps the channel usable instead of noisy.
- **Edge/cloud integrity** — signed payloads with replay protection and bandwidth-efficient thumbnail fetch, matching real telematics architectures.

## Architecture

```
 Live stream (YouTube/HLS/RTSP/mp4)
     │
     ▼
 stream.py  ──►  StreamReader (bg thread, ~2 fps)
     │
     ▼
 detection.py ──► YOLOv8+ByteTrack ──► TTC/distance ──► typed events
     │
     ▼
 server.py  ──► egomotion.py (optical flow) + context.py (scene adaptive)
   │              + quality.py (perception gating) + redact.py (PII)
   │
   ├─► SSE   /stream/events       (push to UI)
   ├─► POST  /chat                (RAG over corpus + live events)
   ├─► GET   /api/live/*          (status, event history, scene, perception)
   ├─► GET   /api/drift           (precision monitoring)
   ├─► GET   /api/fleet/*         (multi-vehicle aggregation, driver scores)
   ├─► GET   /api/llm/*           (LLM cost/latency observability)
   ├─► GET   /api/audit           (compliance audit trail)
   ├─► POST  /api/agents/*        (AI coaching, investigation, reports)
   │
   ├──► llm.py         Claude Haiku (narration + vision enrichment)
   │                   Claude Sonnet (copilot chat, prompt-cached corpus)
   │                   Auto-failover: Anthropic ↔ Azure OpenAI
   │
   ├──► agents.py      Tool-calling AI agents (coaching, investigation, report)
   ├──► fleet.py       Multi-vehicle registry + driver scoring
   ├──► drift.py       Rolling precision + active learning sampler
   ├──► retention.py   GDPR-compliant data expiry (thumbnails, feedback, queues)
   ├──► audit.py       Access audit trail (GDPR Art. 30 / SOC 2)
   ├──► llm_obs.py     Token cost, latency, error rate observability
   └──► slack_notify.py  Tiered alerting (high=instant, medium=hourly, low=daily)
```

## Event types

Two types, derived from geometry on detections:
- `pedestrian_proximity` — person bbox close to a vehicle bbox
- `vehicle_close_interaction` — two vehicle bboxes close

Each event is risk-classified (`high` / `medium` / `low`) using physical-unit TTC + ground-plane distance estimation with scene-adaptive thresholds (highway / urban / parking), has a Claude-generated one-line narration, and annotated + PII-redacted thumbnails.

## Setup

```bash
cd ~/Desktop/fleet-safety-demo
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

First run downloads `yolov8n.pt` (~6 MB) automatically.

## Run — live mode (the demo)

```bash
uvicorn server:app --reload
# open http://127.0.0.1:8000
```

Defaults to a Times Square 24/7 live cam. Override with any RTSP, HLS `.m3u8`, YouTube live URL, or local mp4:

```bash
FLEET_STREAM_SOURCE="rtsp://…" uvicorn server:app --reload
```

The UI has:
- Left column: live event feed, newest-first, with thumbnails + narration + risk badges.
- Right column: operator copilot chat. Ask questions like *"any high-risk pedestrian events in the last 2 minutes?"* — Claude answers grounded in the corpus at [data/corpus/](data/corpus/) + the live event log.

Runs end-to-end **without** an API key — narration just falls back to the templated summary.

### Slack alerts (optional)

Set `SLACK_BOT_TOKEN` (needs `files:write` + `chat:write`), `SLACK_CHANNEL` (channel ID, e.g. `C0123456789`), and optionally `SLACK_MIN_RISK` (default `high`). The server uploads the annotated thumbnail via `files.upload_v2` with the narration + metadata as the message body. Fire-and-forget — never blocks event emission.

### Azure OpenAI swap

Setting `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, and `AZURE_OPENAI_DEPLOYMENT` routes both narration and chat through Azure OpenAI instead of Anthropic. Multi-provider failover is automatic — if the primary fails, the secondary is tried.

## Run — batch mode (legacy)

For offline analysis of a recorded clip:

```bash
python analyze.py data/input.mp4
# produces data/events.json + data/summary.json + thumbnails
```

Served at `/api/events` and `/api/summary`.

## Optional — precision / recall

Hand-label ground truth in `data/labels.json`, then `python eval.py` writes `data/eval.json`.

## Design notes

- **Real stream, not a file.** The point is the live feedback loop — events arrive in the UI as they happen. Solves the #1 bottleneck in fleet-safety review: operator time on raw footage.
- **LLM on metadata, not pixels.** Claude narrates the structured event JSON; vision enrichment (ALPR) is a separate controlled path with self-consistency + circuit breaker.
- **Prompt caching on the RAG corpus.** The statute/policy corpus is tagged `cache_control: ephemeral` so repeated copilot queries pay ~0 cost on the corpus tokens.
- **Graceful degradation.** No API key → templated summaries, chat disabled cleanly. Stream resolution failure → server still serves the UI and batch endpoints.
- **Multi-provider failover.** Anthropic primary → Azure OpenAI secondary (or vice versa). Automatic switchover on provider outage.
- **AI agent orchestration.** Tool-calling agents for coaching, investigation, and report generation — each with bounded tool sets to avoid hallucination.
- **Privacy by design.** Dual-thumbnail PII redaction, plate hashing, DSAR-gated access, audit logging, configurable data retention.
- **Production observability.** Token cost tracking, latency percentiles, error/skip rates, drift monitoring with Slack alerts.
- **Fleet-ready data model.** Vehicle ID, fleet ID, driver scoring, fleet-wide aggregation — ready for multi-vehicle expansion.

## API reference

| Endpoint | Method | Description |
|---|---|---|
| `/stream/events` | GET | SSE live event feed |
| `/chat` | POST | RAG copilot chat |
| `/api/live/status` | GET | System status + perception state |
| `/api/live/events` | GET | Recent events (filterable) |
| `/api/live/scene` | GET | Scene context + adaptive thresholds |
| `/api/live/perception` | GET | Perception quality state |
| `/api/drift` | GET | Rolling precision + trend |
| `/api/feedback` | POST/GET | Operator verdict submission |
| `/api/coaching_queue` | GET | Pending medium-risk events for review |
| `/api/active_learning/export` | POST | Export samples for labeling |
| `/api/fleet/summary` | GET | Fleet-wide aggregation |
| `/api/fleet/vehicle/{id}` | GET | Per-vehicle stats + score |
| `/api/fleet/drivers` | GET | Driver safety leaderboard |
| `/api/agents/coaching` | POST | AI coaching note generator |
| `/api/agents/investigation` | POST | AI event investigation |
| `/api/agents/report` | POST | AI safety summary report |
| `/api/llm/stats` | GET | LLM cost, latency, error rates |
| `/api/llm/recent` | GET | Raw recent LLM call log |
| `/api/audit` | GET | Compliance audit trail |
| `/api/audit/stats` | GET | Audit summary counts |
| `/api/retention/sweep` | POST | Trigger data retention sweep |

## Not in scope (deliberately)

- Training / fine-tuning detectors
- Multi-camera fan-out within a single process
- Production-grade edge deployment (this is a laptop demo; the architecture is streaming-ready)
