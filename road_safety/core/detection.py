"""Shared detection + event logic. Used by both analyze.py (batch) and server.py (live).

Upgraded from per-frame detection to identity-persistent tracking (ByteTrack) so
downstream code can reason about the *same* object across frames. This unlocks
two things the pixel-distance heuristic could never deliver:

  1. Per-pair event dedup (a single episode between track_id=7 and track_id=12
     fires once, not N times at 2 fps).
  2. Kinematic risk — time-to-collision from bbox-scale growth, and rough
     distance-in-meters from the pinhole/ground-plane assumption. Risk is now
     a physical quantity (TTC seconds / metres), not a pixel count.

Falls back gracefully: if the tracker returns no IDs (first frames, or
non-trackable inputs), detections still flow through with track_id=None and
downstream code degrades to the old per-frame behaviour.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import cv2
from ultralytics import YOLO

VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}
PEDESTRIAN_CLASSES = {"person"}

CONF_THRESHOLD = 0.60
from road_safety.config import MODEL_PATH
TRACKER_CFG = "bytetrack.yaml"

# Pinhole/ground-plane approximation — dashcam mounted ~1.4m above road,
# ~800px horizontal focal length for a typical 1080p wide-angle lens.
# These are deliberately coarse: real systems calibrate per-camera.
CAMERA_HEIGHT_M = 1.4
FOCAL_PX = 800.0

# Typical real-world heights (m) used to back out distance from bbox height
# when the ground-plane assumption fails (e.g. occluded feet).
TYPICAL_HEIGHT_M = {
    "person": 1.7,
    "car": 1.5,
    "truck": 3.0,
    "bus": 3.2,
    "motorcycle": 1.3,
}

# Risk thresholds in *physical* units — these are defensible across any camera,
# resolution, or framing, unlike pixel thresholds.
TTC_HIGH_SEC = 1.5      # FCW trigger band per NHTSA / AXA research
TTC_MED_SEC = 3.0
DIST_HIGH_M = 3.0       # arm's length + a step
DIST_MED_M = 8.0        # roughly 1.5 vehicle lengths

# Trailing-frames ring per track for TTC (need ≥ 2 samples to differentiate).
TRACK_HISTORY_LEN = 8


@dataclass
class Detection:
    cls: str
    conf: float
    x1: int
    y1: int
    x2: int
    y2: int
    track_id: int | None = None

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x1 + self.x2) / 2, (self.y1 + self.y2) / 2)

    @property
    def width(self) -> int:
        return max(self.x2 - self.x1, 1)

    @property
    def height(self) -> int:
        return max(self.y2 - self.y1, 1)

    @property
    def bottom(self) -> int:
        return self.y2


@dataclass
class TrackSample:
    t: float
    height: int
    bottom: int


class TrackHistory:
    """Ring of recent observations keyed by track_id — backs TTC estimation."""

    def __init__(self, maxlen: int = TRACK_HISTORY_LEN):
        self._tracks: dict[int, deque[TrackSample]] = {}
        self._maxlen = maxlen

    def update(self, det: Detection, t: float) -> None:
        if det.track_id is None:
            return
        dq = self._tracks.setdefault(det.track_id, deque(maxlen=self._maxlen))
        dq.append(TrackSample(t=t, height=det.height, bottom=det.bottom))

    def samples(self, track_id: int | None) -> list[TrackSample]:
        if track_id is None:
            return []
        return list(self._tracks.get(track_id, ()))

    def prune(self, live_ids: set[int], now: float, stale_sec: float = 10.0) -> None:
        dead = [
            tid for tid, dq in self._tracks.items()
            if tid not in live_ids and (not dq or now - dq[-1].t > stale_sec)
        ]
        for tid in dead:
            self._tracks.pop(tid, None)


def load_model(path: str = MODEL_PATH) -> YOLO:
    return YOLO(path)


def bbox_edge_distance(a: Detection, b: Detection) -> float:
    dx = max(a.x1 - b.x2, b.x1 - a.x2, 0)
    dy = max(a.y1 - b.y2, b.y1 - a.y2, 0)
    return (dx * dx + dy * dy) ** 0.5


def estimate_distance_m(det: Detection, frame_h: int) -> float | None:
    """Monocular distance estimate. Returns None if we can't get a sane number.

    Strategy — take the more reliable of two priors:
      (a) Ground plane: if the bbox bottom is below the horizon (assumed
          mid-frame), distance = f * H_camera / (y_bottom - y_horizon).
      (b) Known-height prior: distance = f * H_real / bbox_height_px.

    We return the larger (more conservative) of the two — preferring to
    under-alert on distance rather than hallucinate a close call.
    """
    known_h = TYPICAL_HEIGHT_M.get(det.cls)
    horizon_y = frame_h * 0.5

    dist_height: float | None = None
    if known_h is not None and det.height > 4:
        dist_height = FOCAL_PX * known_h / det.height

    dist_ground: float | None = None
    dy = det.bottom - horizon_y
    if dy > 4:
        dist_ground = FOCAL_PX * CAMERA_HEIGHT_M / dy

    candidates = [d for d in (dist_height, dist_ground) if d is not None and 0.5 < d < 200]
    if not candidates:
        return None
    return round(max(candidates), 2)


def estimate_ttc_sec(history: list[TrackSample]) -> float | None:
    """Time-to-collision from bbox-scale growth (scale-expansion TTC).

    If the object's bbox height is growing frame-over-frame, the object is
    approaching. TTC ≈ Δt / (scale - 1). Ego-motion-invariant in the
    longitudinal axis — doesn't need to know whether we're moving or they are.

    Returns None if shrinking, static, or insufficient data.
    """
    if len(history) < 3:
        return None
    first, last = history[0], history[-1]
    dt = last.t - first.t
    if dt <= 0.1:
        return None
    scale = last.height / max(first.height, 1)
    if scale <= 1.02:  # not approaching (or noise)
        return None
    ttc = dt / (scale - 1.0)
    if not math.isfinite(ttc) or ttc <= 0 or ttc > 30:
        return None
    return round(ttc, 2)


def classify_risk(ttc_sec: float | None, distance_m: float | None, fallback_px: float) -> str:
    """Physical-unit risk classification with graceful pixel fallback.

    Priority: TTC > distance_m > pixel heuristic. Any signal triggering the
    'high' band wins; the output is the worst (most severe) of the signals.
    """
    levels = []
    if ttc_sec is not None:
        if ttc_sec <= TTC_HIGH_SEC:
            levels.append("high")
        elif ttc_sec <= TTC_MED_SEC:
            levels.append("medium")
    if distance_m is not None:
        if distance_m <= DIST_HIGH_M:
            levels.append("high")
        elif distance_m <= DIST_MED_M:
            levels.append("medium")
    if ttc_sec is None and distance_m is None:
        if fallback_px <= 60:
            levels.append("high")
        elif fallback_px <= 180:
            levels.append("medium")

    if "high" in levels:
        return "high"
    if "medium" in levels:
        return "medium"
    return "low"


def detect_frame(model: YOLO, frame, persistent: bool = True) -> list[Detection]:
    """Run YOLO tracking on a frame and return filtered Detection objects.

    `persistent=True` keeps track IDs stable across calls — required for TTC
    and per-pair dedup. Set False only for isolated single-frame calls.
    """
    if persistent:
        results = model.track(
            frame, persist=True, tracker=TRACKER_CFG, verbose=False
        )[0]
    else:
        results = model(frame, verbose=False)[0]

    names = results.names
    out: list[Detection] = []
    boxes = results.boxes
    if boxes is None:
        return out

    ids = boxes.id.int().tolist() if boxes.id is not None else [None] * len(boxes)
    for box, tid in zip(boxes, ids):
        cls = names[int(box.cls)]
        if cls not in VEHICLE_CLASSES and cls not in PEDESTRIAN_CLASSES:
            continue
        conf = float(box.conf)
        if conf < CONF_THRESHOLD:
            continue
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
        w, h = x2 - x1, y2 - y1
        if cls == "person" and h > 0 and w / h > 0.7:
            continue
        out.append(Detection(cls=cls, conf=conf, x1=x1, y1=y1, x2=x2, y2=y2, track_id=tid))
    return out


def find_interactions(
    detections: list[Detection],
) -> list[tuple[str, Detection, Detection, float]]:
    pedestrians = [d for d in detections if d.cls in PEDESTRIAN_CLASSES]
    vehicles = [d for d in detections if d.cls in VEHICLE_CLASSES]
    candidates = []

    for ped in pedestrians:
        for veh in vehicles:
            dist = bbox_edge_distance(ped, veh)
            if dist <= 180:
                candidates.append(("pedestrian_proximity", ped, veh, dist))

    for i, a in enumerate(vehicles):
        for b in vehicles[i + 1 :]:
            dist = bbox_edge_distance(a, b)
            if dist <= 60:
                candidates.append(("vehicle_close_interaction", a, b, dist))

    return candidates


def draw_thumbnail(frame, primary: Detection, secondary: Detection, path: Path) -> None:
    annotated = frame.copy()
    for det, color in [(primary, (0, 0, 255)), (secondary, (0, 200, 255))]:
        cv2.rectangle(annotated, (det.x1, det.y1), (det.x2, det.y2), color, 2)
        label = f"{det.cls} {det.conf:.2f}"
        if det.track_id is not None:
            label = f"#{det.track_id} {label}"
        cv2.putText(
            annotated,
            label,
            (det.x1, max(det.y1 - 6, 12)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            color,
            1,
            cv2.LINE_AA,
        )
    cv2.imwrite(str(path), annotated)


def build_event_summary(
    event_type: str,
    a: Detection,
    b: Detection,
    distance: float,
    risk: str,
    ttc_sec: float | None = None,
    distance_m: float | None = None,
) -> str:
    parts = [f"{a.cls.title()} and {b.cls}"]
    if distance_m is not None:
        parts.append(f"~{distance_m:.1f}m apart")
    else:
        parts.append(f"within {int(distance)}px")
    if ttc_sec is not None:
        parts.append(f"TTC {ttc_sec:.1f}s")
    parts.append(f"(risk={risk}).")
    return " ".join(parts)
