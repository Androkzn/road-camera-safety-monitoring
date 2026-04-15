"""
Fleet safety event extraction.

Reads a video, samples frames, runs object detection, and emits structured
safety events (pedestrian proximity, vehicle proximity) with thumbnails.

Usage:
    python analyze.py data/input.mp4
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
from ultralytics import YOLO

DATA_DIR = Path(__file__).parent / "data"
THUMBS_DIR = DATA_DIR / "thumbnails"
EVENTS_PATH = DATA_DIR / "events.json"
SUMMARY_PATH = DATA_DIR / "summary.json"

SAMPLE_FPS = 2
VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}
PEDESTRIAN_CLASSES = {"person"}

HIGH_RISK_PX = 60
MED_RISK_PX = 180

EVENT_MERGE_WINDOW_SEC = 2.0


@dataclass
class Detection:
    cls: str
    conf: float
    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x1 + self.x2) / 2, (self.y1 + self.y2) / 2)


@dataclass
class Event:
    event_id: str
    video_id: str
    timestamp_sec: float
    event_type: str
    risk_level: str
    confidence: float
    objects: list[str]
    summary: str
    thumbnail: str


def bbox_edge_distance(a: Detection, b: Detection) -> float:
    """Minimum pixel distance between two bounding boxes (0 if overlapping)."""
    dx = max(a.x1 - b.x2, b.x1 - a.x2, 0)
    dy = max(a.y1 - b.y2, b.y1 - a.y2, 0)
    return (dx * dx + dy * dy) ** 0.5


def classify_risk(distance_px: float) -> str:
    if distance_px <= HIGH_RISK_PX:
        return "high"
    if distance_px <= MED_RISK_PX:
        return "medium"
    return "low"


def draw_thumbnail(frame, primary: Detection, secondary: Detection, path: Path) -> None:
    annotated = frame.copy()
    for det, color in [(primary, (0, 0, 255)), (secondary, (0, 200, 255))]:
        cv2.rectangle(annotated, (det.x1, det.y1), (det.x2, det.y2), color, 2)
        cv2.putText(
            annotated,
            f"{det.cls} {det.conf:.2f}",
            (det.x1, max(det.y1 - 6, 12)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            color,
            1,
            cv2.LINE_AA,
        )
    cv2.imwrite(str(path), annotated)


def detect_frame(model: YOLO, frame) -> list[Detection]:
    results = model(frame, verbose=False)[0]
    names = results.names
    out: list[Detection] = []
    for box in results.boxes:
        cls = names[int(box.cls)]
        if cls not in VEHICLE_CLASSES and cls not in PEDESTRIAN_CLASSES:
            continue
        conf = float(box.conf)
        if conf < 0.4:
            continue
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
        out.append(Detection(cls=cls, conf=conf, x1=x1, y1=y1, x2=x2, y2=y2))
    return out


def find_interactions(
    detections: list[Detection],
) -> list[tuple[str, Detection, Detection, float]]:
    """Return (event_type, primary, secondary, distance) candidates for one frame."""
    pedestrians = [d for d in detections if d.cls in PEDESTRIAN_CLASSES]
    vehicles = [d for d in detections if d.cls in VEHICLE_CLASSES]
    candidates = []

    for ped in pedestrians:
        for veh in vehicles:
            dist = bbox_edge_distance(ped, veh)
            if dist <= MED_RISK_PX:
                candidates.append(("pedestrian_proximity", ped, veh, dist))

    for i, a in enumerate(vehicles):
        for b in vehicles[i + 1 :]:
            dist = bbox_edge_distance(a, b)
            if dist <= HIGH_RISK_PX:
                candidates.append(("vehicle_close_interaction", a, b, dist))

    return candidates


def merge_events(raw: list[dict]) -> list[dict]:
    """Collapse consecutive same-type events into one representative event."""
    merged: list[dict] = []
    for ev in sorted(raw, key=lambda e: e["timestamp_sec"]):
        if merged:
            last = merged[-1]
            same_type = last["event_type"] == ev["event_type"]
            close_in_time = ev["timestamp_sec"] - last["timestamp_sec"] <= EVENT_MERGE_WINDOW_SEC
            if same_type and close_in_time:
                if ev["_distance"] < last["_distance"]:
                    merged[-1] = ev
                continue
        merged.append(ev)
    for ev in merged:
        ev.pop("_distance", None)
    return merged


def build_summary(video_id: str, duration_sec: float, events: list[dict]) -> dict:
    by_type: dict[str, int] = {}
    by_risk: dict[str, int] = {}
    for ev in events:
        by_type[ev["event_type"]] = by_type.get(ev["event_type"], 0) + 1
        by_risk[ev["risk_level"]] = by_risk.get(ev["risk_level"], 0) + 1

    if by_risk.get("high", 0) >= 2:
        trip_class = "risky"
    elif by_risk.get("high", 0) + by_risk.get("medium", 0) >= 2:
        trip_class = "moderate"
    else:
        trip_class = "safe"

    parts = []
    for etype, count in by_type.items():
        parts.append(f"{count} {etype.replace('_', ' ')}")
    narrative = (
        f"This trip contained {len(events)} safety event(s): " + ", ".join(parts) + "."
        if events
        else "No safety events detected in this trip."
    )

    avg_conf = round(sum(e["confidence"] for e in events) / len(events), 3) if events else 0.0

    return {
        "video_id": video_id,
        "duration_sec": round(duration_sec, 2),
        "trip_classification": trip_class,
        "event_count": len(events),
        "events_by_type": by_type,
        "events_by_risk": by_risk,
        "avg_confidence": avg_conf,
        "narrative": narrative,
    }


def analyze(video_path: Path) -> None:
    if not video_path.exists():
        sys.exit(f"Video not found: {video_path}")

    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    for old in THUMBS_DIR.glob("*.jpg"):
        old.unlink()

    video_id = video_path.stem
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = total_frames / fps
    step = max(int(fps / SAMPLE_FPS), 1)

    print(f"Video: {video_id}  fps={fps:.1f}  frames={total_frames}  duration={duration_sec:.1f}s")
    print(f"Sampling every {step} frames (~{SAMPLE_FPS} fps)")

    model = YOLO("yolov8n.pt")

    raw_events: list[dict] = []
    frame_idx = 0
    processed = 0
    started = time.time()

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx % step != 0:
            frame_idx += 1
            continue

        timestamp = frame_idx / fps
        detections = detect_frame(model, frame)
        for event_type, a, b, distance in find_interactions(detections):
            risk = classify_risk(distance)
            if event_type == "pedestrian_proximity" and risk == "low":
                continue
            event_id = f"evt_{len(raw_events):04d}"
            thumb_name = f"{event_id}.jpg"
            draw_thumbnail(frame, a, b, THUMBS_DIR / thumb_name)
            raw_events.append(
                {
                    "event_id": event_id,
                    "video_id": video_id,
                    "timestamp_sec": round(timestamp, 2),
                    "event_type": event_type,
                    "risk_level": risk,
                    "confidence": round(min(a.conf, b.conf), 3),
                    "objects": sorted({a.cls, b.cls}),
                    "summary": (
                        f"{a.cls.title()} and {b.cls} within {int(distance)}px "
                        f"(risk={risk})."
                    ),
                    "thumbnail": f"thumbnails/{thumb_name}",
                    "_distance": distance,
                }
            )
        processed += 1
        frame_idx += 1

    cap.release()

    events = merge_events(raw_events)
    for i, ev in enumerate(events):
        ev["event_id"] = f"evt_{i:04d}"

    EVENTS_PATH.write_text(json.dumps(events, indent=2))
    summary = build_summary(video_id, duration_sec, events)
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2))

    elapsed = time.time() - started
    print(
        f"Done. Processed {processed} frames in {elapsed:.1f}s "
        f"({processed / max(elapsed, 1e-6):.1f} fps). "
        f"Wrote {len(events)} event(s)."
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python analyze.py <video_path>")
    analyze(Path(sys.argv[1]))
