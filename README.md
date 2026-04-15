# Fleet Safety Event Detection — Demo

Turns dashcam/road footage into **structured, searchable safety events** with an operator review UI.

Not a detection demo — a pipeline demo. The point is the shape of the output (typed events, thumbnails, risk, summary) and the workflow on top (review, filter, seek).

## Architecture

```
 video file
     │
     ▼
 analyze.py ──► YOLOv8 (pretrained) ──► interaction rules ──► event merge
     │
     ▼
 data/events.json  +  data/summary.json  +  data/thumbnails/*.jpg
     │
     ▼
 server.py (FastAPI)  ──►  static/index.html (review UI)
```

## Events produced

Two event types, derived from geometric rules on detections (not a trained model):

- `pedestrian_proximity` — person bbox close to a vehicle bbox
- `vehicle_close_interaction` — two vehicle bboxes close

Each event is risk-classified (`high` / `medium` / `low`) by pixel distance, carries confidence, and has an annotated thumbnail.

## Setup

```bash
cd ~/Desktop/fleet-safety-demo
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

First run downloads `yolov8n.pt` (~6 MB) automatically.

## Run

```bash
# 1. Drop any mp4 into ./data/ (e.g. data/input.mp4)
python analyze.py data/input.mp4

# 2. Start the review UI
uvicorn server:app --reload

# 3. Open http://127.0.0.1:8000
```

## Optional — precision / recall

Hand-label a few ground-truth events in `data/labels.json`:

```json
[
  {"timestamp_sec": 12.5, "event_type": "pedestrian_proximity"},
  {"timestamp_sec": 31.0, "event_type": "vehicle_close_interaction"}
]
```

Then:

```bash
python eval.py
```

Writes `data/eval.json` with precision / recall / F1.

## Design notes

- **Pretrained model, not trained.** Scope control — the goal is the pipeline, not a better detector.
- **Geometric rules for events.** Makes behavior debuggable and keeps false positives controllable without a second model.
- **Event merging.** Consecutive same-type detections within 2s collapse to one event — one incident, one row.
- **Evaluation layer.** Hand-labeled ground truth + precision/recall is what separates a demo from something you'd iterate on in production.
- **UI is thin on purpose.** Thumbnail + timestamp + type + risk. Click to seek. That's the operator workflow.

## Not in scope (deliberately)

- Training / fine-tuning
- Real-time streaming ingestion (architecture is streaming-ready — demoed on recorded footage)
- Multi-camera, auth, uploads, ALPR, driver scoring
