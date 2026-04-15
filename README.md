# Road Safety

Real-time road safety monitoring system. Pulls a live camera stream, detects pedestrian-vehicle and vehicle-vehicle proximity events with YOLOv8 + ByteTrack, narrates each incident with Claude, and exposes an operator copilot with RAG over a statute/policy corpus.

---

## Screenshots

![Admin Panel](docs/screenshots/admin.png)

![Dashboard](docs/screenshots/dashboard.png)

![Test Suite](docs/screenshots/tests.png)

---

## Quick start

```bash
git clone <repo-url> && cd road-safety
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
python start.py
```

Or with Docker: `docker compose up --build`

---

## Challenges & How We Address Them

### 1. False Positives & Alert Fatigue

False positives are the #1 complaint from road operators. Basic systems fire on every close proximity event without understanding context — parking-lot maneuvers, highway following distances, or normal intersection crossings. Drivers learn to ignore the system and the safety value drops to zero.

**Our approach: layered gating where a real conflict satisfies all layers and noise fails at the first.**

| Layer | What it does |
|---|---|
| **Multi-gate TTC** | Time-to-collision fires only after 5 independent gates: ≥4-sample window spanning ≥1.5s, monotonic bbox growth, jitter-floor pixel delta, non-trivial track motion, and scale ratio above noise floor. Pair-TTC adds monotonic distance decrease and minimum closing rate. |
| **Ego-motion gating** | TTC is discarded when neither track shows approach residual against optical-flow ego-motion. Bbox jitter on stationary objects cannot fire alarms. |
| **Depth-aware proximity** | Vehicle interactions are gated on monocular 3D depth difference, not image-plane overlap. Distant cars whose bboxes overlap due to perspective are not flagged. |
| **Scene-adaptive thresholds** | Urban / highway / parking classification rescales TTC and distance bands dynamically. Highway widens for reaction time; parking tightens for close-quarters. |
| **Sustained-risk episodes** | Track-pair interactions accumulate into episodes. Peak risk is downgraded if not sustained over ≥2 frames and ≥1.0s. |
| **Perception-quality gating** | When the camera is degraded (low light, blur), thresholds tighten conservatively and low-confidence events are suppressed. |
| **Operator feedback loop** | Operators mark events tp/fp. Drift monitor tracks rolling precision and alerts on degradation. Disputed events feed active learning. |

### 2. Edge/Cloud Latency & Bandwidth

Raw HD video at 10 Mbps produces ~1 GB/day/camera. Transmitting that from thousands of vehicles on cellular is economically impossible. Real-time safety requires sub-second latency, but cloud adds 100-500ms+ round-trip.

**Our approach: all perception runs on-device. Only typed JSON (~2 KB) + redacted thumbnails (~8 KB) cross the wire — a 2,000-10,000x bandwidth reduction.**

| Layer | What it does |
|---|---|
| **Edge-first architecture** | Detection, tracking, risk classification, and PII redaction run on-device. Cloud receives only structured events. |
| **Lightweight model** | YOLOv8n (nano) — smallest YOLO variant, runs at 2 fps on laptop CPU. |
| **HMAC-signed batched delivery** | Events queue locally in append-only JSONL. Batches of up to 20 are signed and POSTed together. Survives network outages with exponential backoff. |
| **Selective LLM enrichment** | Vision enrichment is skipped when perception is degraded or for low-risk events. No wasted API calls. |

### 3. LLM Reliability in Production

LLM integration in safety systems faces: rate limiting, hallucination in narration/enrichment, linear cost scaling with event volume, and single-provider outages.

**Our approach: the LLM is an enrichment layer, not a critical path. Detection works with zero LLM calls. Narration adds value when available and degrades silently when not.**

| Layer | What it does |
|---|---|
| **Multi-provider failover** | Anthropic ↔ Azure OpenAI automatic fallback on errors. |
| **Client-side rate budget** | Token-bucket limiter (3 req/min) refuses calls *before* triggering 429 errors. |
| **Circuit breaker** | After 3 consecutive failures, breaker opens for 60s, halving API load during storms. |
| **Self-consistency ALPR** | Two independent vision calls at different temperatures. If plate readings disagree, output is null rather than hallucinated. |
| **Cost observability** | Every call instrumented: tokens, latency, USD cost, success/failure. Exposed via `/api/llm/stats`. |

### 4. Privacy & Regulatory Compliance (GDPR/CCPA)

Road cameras capture faces, plates, and location — all PII under GDPR/CCPA. Fines exceed 70M EUR. License plates create tracking profiles. Organizations must demonstrate what data they hold and who accessed it.

**Our approach: privacy by design, not by policy. Raw PII never reaches an external channel by construction — the code path makes it structurally impossible.**

| Layer | What it does |
|---|---|
| **Dual thumbnails** | Every event produces internal (unredacted, local-only) and public (faces + plates blurred) versions. All external channels receive only the public version. |
| **Plate hashing** | Raw plate text is immediately converted to a salted SHA-256 hash. Enables cross-event correlation without storing actual plates. |
| **DSAR-gated access** | Unredacted thumbnails require an `X-DSAR-Token` header. Denied attempts are audit-logged. |
| **Audit trail** | Every sensitive access is logged: timestamp, actor, action, resource, outcome, IP. GDPR Art. 30 / SOC 2 ready. |
| **Automated retention** | Hourly sweeps delete data past configurable windows: thumbnails 30d, feedback 90d, active-learning 60d. GDPR Art. 5(1)(e). |

### 5. Model Drift & Continuous Improvement

CV models degrade in production. Weather changes, new camera angles, seasonal lighting — all cause distribution shift. Without monitoring, precision silently degrades until operators lose trust. Retraining requires labeled data, which is expensive.

**Our approach: the feedback loop is a first-class feature. Operator verdicts flow directly into precision monitoring and training data selection.**

| Layer | What it does |
|---|---|
| **Rolling precision** | Joins operator feedback with emitted events. Computes precision sliced by risk level and event type. |
| **Trend detection** | Compares current window against prior non-overlapping window. Reports improving / stable / degrading. |
| **Active learning** | Events near the decision boundary (confidence 0.35-0.50) are sampled for relabeling. Disputed (fp-marked) events are always captured. |
| **Label tool export** | Pending samples bundle into zip with manifest JSON, ready for Label Studio / CVAT import. |

### 6. Scaling to Multi-Vehicle Roads

Scaling from one camera to thousands of vehicles requires vehicle identity, road-wide aggregation, and driver scoring. The data model must support road-scale operations from day one.

**Our approach: single-vehicle and multi-vehicle deployments use the same data model. Adding vehicles is a configuration change, not a code change.**

| Layer | What it does |
|---|---|
| **Vehicle/road identity** | Every event carries `vehicle_id`, `road_id`, `driver_id`. Events are attributable from creation. |
| **Driver scoring** | Decaying penalty model: high-risk events deduct 10 points from max 100. Scores recover 0.5/hour. |
| **Road-wide aggregation** | `/api/road/summary` provides aggregate counts. `/api/road/drivers` ranks drivers worst-first. |

### 7. AI Agent Orchestration

60% of enterprise AI agent pilots fail to scale. Root causes: process mirroring (38%), lack of observability (27%), context collapse (22%), and tool overload (13%).

**Our approach: single-responsibility agents with bounded tool sets. No agent has more than 5 tools. Agents recommend — operators decide.**

| Layer | What it does |
|---|---|
| **Coaching agent** | Retrieves event + road policy, generates structured coaching note with specific driver action items. |
| **Investigation agent** | Correlates event with similar events, feedback, and drift data. Produces root-cause hypothesis with confidence. |
| **Report agent** | Queries event counts, feedback, and drift across the session. Produces structured safety summary. |
| **Hard stops** | Max 5 iteration steps. Returns with what it has rather than looping. |
| **Observability** | Agent LLM calls instrumented with same cost/latency tracking. Invocations audit-logged. |

---

## Summary

| Challenge | Industry Pain | Our Approach |
|---|---|---|
| False positives | Alert fatigue, driver distrust | 7-layer gating: TTC gates, ego-motion, depth, scene-adaptive, episodes, perception quality, feedback |
| Edge/cloud bandwidth | 1 GB/day/camera | 2,000-10,000x reduction, edge-first, batched delivery |
| LLM reliability | Rate limits, hallucination, cost | Multi-provider failover, circuit breaker, self-consistency, rate budget |
| Privacy compliance | GDPR fines >70M EUR | Dual thumbnails, plate hashing, DSAR gating, audit trail, auto-retention |
| Model drift | Silent precision degradation | Rolling precision, trend detection, active learning, disputed sampling |
| Road scaling | Single camera → 1.5M vehicles | Vehicle/road identity, driver scoring, road-wide aggregation |
| Agent orchestration | 60% pilot failure | Bounded tools, structured output, hard stops, observability |

---

## Testing

```bash
make test    # or: pytest tests/ -v
```

119 tests covering detection pipeline, services, API routes, compliance, and integrations.

## License

MIT — see [LICENSE](LICENSE).
