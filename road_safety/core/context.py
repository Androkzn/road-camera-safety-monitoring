"""context.py — classifies the scene so risk thresholds adapt to it.

What it does:
    Watches a rolling window of detections plus an optional ego-speed
    signal and decides whether the camera is currently on a highway,
    in an urban street, in a parking lot, or unknown. Based on that
    label it returns adaptive numeric thresholds (TTC seconds and
    distance metres) that `detection.py` uses instead of fixed "one
    size fits all" numbers.

Purpose:
    A 1.5-second time-to-collision means something very different at
    65 mph on a highway (crash unavoidable) vs. 3 mph in a parking lot
    (normal clearance). Using fixed thresholds either under-alerts on
    highways or drowns parking-lot driving in false positives. This
    module solves that by picking thresholds that match the scene.

How it works:
    `@dataclass` (a Python class decorator) auto-generates an
    `__init__` for the `SceneContext` record type — label, confidence,
    pedestrian rate, ego-speed proxy. A `deque` (double-ended queue) is
    a fixed-size rolling buffer — cheap to append to and trim. The
    classifier uses always-available, cheap signals: how many
    pedestrians vs. vehicles have been seen in the last 60 seconds,
    density patterns, and — if `core/egomotion.py` supplied a value —
    the ego-speed proxy in m/s. No imports from `detection.py`
    (additive and decoupled); it just needs objects with a `.cls`
    attribute. The module-level defaults match `detection.py`'s
    original fixed constants so "unknown" behaves like the old code.

Connects to:
    - Backend: consumed by `road_safety/server.py`, which instantiates
      `SceneContextClassifier`, feeds it every detection frame, and
      reads `adaptive_thresholds()` before calling
      `classify_risk(...)` from `core/detection.py`. Ego-speed input
      comes from `core/egomotion.py`.
    - UI: the scene label and pedestrian rate are exposed via the
      `/api/live/scene` endpoint -> `useScene` hook ->
      `frontend/src/components/dashboard/PerceptionBanner.tsx`, which
      shows the operator what context the system currently thinks it's
      in.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass


# Class sets — kept local so we don't depend on detection.py imports.
_PEDESTRIAN_CLASSES = {"person"}
_VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}

# Parking rule looks at a shorter tail than the main window, because a
# vehicle can cross a quiet residential street in <60s and we don't want
# that to be mistaken for "parking lot".
_PARKING_WINDOW_SEC = 30.0

# Default thresholds — these mirror detection.py's module constants so an
# "unknown" scene behaves exactly like today.
_DEFAULT_TTC_HIGH = 0.5
_DEFAULT_TTC_MED = 1.0
_DEFAULT_DIST_HIGH = 2.0
_DEFAULT_DIST_MED = 5.0


@dataclass
class SceneContext:
    label: str                     # "urban" | "highway" | "parking" | "unknown"
    confidence: float              # 0..1
    speed_proxy_mps: float | None  # from ego-flow if available
    pedestrian_rate_per_min: float # rolling 60s
    vehicle_rate_per_min: float    # rolling 60s
    reason: str                    # short human-readable justification


@dataclass
class AdaptiveThresholds:
    ttc_high_sec: float
    ttc_med_sec: float
    dist_high_m: float
    dist_med_m: float


class SceneContextClassifier:
    """Rolling scene classifier fed one frame's detections at a time.

    Thread-model: single-threaded, one instance per camera/stream.
    Performance: O(k) per observe() where k is the prune count; fine at 2fps.
    """

    def __init__(self, window_sec: float = 60.0):
        self._window_sec = window_sec
        # (ts, cls) tuples. deque for O(1) append; prune is linear from left.
        self._events: deque[tuple[float, str]] = deque()
        self._last_ts: float = 0.0
        self._last_speed: float | None = None

    def observe(
        self,
        detections: list,
        now_ts: float,
        speed_proxy_mps: float | None = None,
    ) -> None:
        """Call once per frame. Updates rolling detection-density windows."""
        self._last_ts = now_ts
        self._last_speed = speed_proxy_mps

        for det in detections:
            cls = getattr(det, "cls", None)
            if cls in _PEDESTRIAN_CLASSES or cls in _VEHICLE_CLASSES:
                self._events.append((now_ts, cls))

        # Prune anything older than now - window_sec from the left.
        cutoff = now_ts - self._window_sec
        while self._events and self._events[0][0] < cutoff:
            self._events.popleft()

    def _rates(self, window_sec: float) -> tuple[float, float]:
        """Return (pedestrian_per_min, vehicle_per_min) over the last window_sec."""
        if window_sec <= 0:
            return 0.0, 0.0
        cutoff = self._last_ts - window_sec
        peds = 0
        vehs = 0
        # Iterate from the right (newest first) and stop once we cross cutoff.
        # The deque is time-ordered so this is safe.
        for ts, cls in reversed(self._events):
            if ts < cutoff:
                break
            if cls in _PEDESTRIAN_CLASSES:
                peds += 1
            elif cls in _VEHICLE_CLASSES:
                vehs += 1
        window_min = window_sec / 60.0
        return peds / window_min, vehs / window_min

    def classify(self) -> SceneContext:
        ped_rate, veh_rate = self._rates(self._window_sec)
        speed = self._last_speed

        # Rule 1 — highway: fast and not many pedestrians.
        if speed is not None and speed > 13 and ped_rate < 1:
            return SceneContext(
                label="highway",
                confidence=0.8,
                speed_proxy_mps=speed,
                pedestrian_rate_per_min=ped_rate,
                vehicle_rate_per_min=veh_rate,
                reason=f"speed {speed:.1f} m/s > 13 and pedestrian rate {ped_rate:.1f}/min < 1",
            )

        # Rule 2 — urban: dense pedestrians, or dense vehicles at low/unknown speed.
        slow_or_unknown = speed is None or speed < 8
        if ped_rate > 3 or (veh_rate > 6 and slow_or_unknown):
            return SceneContext(
                label="urban",
                confidence=0.7,
                speed_proxy_mps=speed,
                pedestrian_rate_per_min=ped_rate,
                vehicle_rate_per_min=veh_rate,
                reason=(
                    f"pedestrian rate {ped_rate:.1f}/min > 3"
                    if ped_rate > 3
                    else f"vehicle rate {veh_rate:.1f}/min > 6 at low/unknown speed"
                ),
            )

        # Rule 3 — parking: almost no traffic in the last 30s.
        ped30, veh30 = self._rates(_PARKING_WINDOW_SEC)
        if veh30 < 0.5 and ped30 < 0.5:
            return SceneContext(
                label="parking",
                confidence=0.6,
                speed_proxy_mps=speed,
                pedestrian_rate_per_min=ped_rate,
                vehicle_rate_per_min=veh_rate,
                reason=(
                    f"last 30s: vehicle {veh30:.2f}/min < 0.5 and "
                    f"pedestrian {ped30:.2f}/min < 0.5"
                ),
            )

        # Rule 4 — fallback.
        return SceneContext(
            label="unknown",
            confidence=0.3,
            speed_proxy_mps=speed,
            pedestrian_rate_per_min=ped_rate,
            vehicle_rate_per_min=veh_rate,
            reason="no rule matched; using default thresholds",
        )

    def adaptive_thresholds(self, ctx: SceneContext) -> AdaptiveThresholds:
        """Scene-calibrated replacements for detection.py's module constants.

        Calibrated for *observation/analytics* cameras, not in-vehicle FCW.
        Based on SSAM, SAFE-UP, and PET research:
        - PET > 1.0 s → low severity (no evasive action needed)
        - Only sub-second closing at converging angles is genuinely high-risk
        """
        if ctx.label == "highway":
            # 65 mph ~ 29 m/s — higher speed requires more reaction time.
            return AdaptiveThresholds(
                ttc_high_sec=1.5, ttc_med_sec=3.0,
                dist_high_m=5.0, dist_med_m=15.0,
            )
        if ctx.label == "urban":
            return AdaptiveThresholds(
                ttc_high_sec=0.4, ttc_med_sec=0.8,
                dist_high_m=1.5, dist_med_m=3.0,
            )
        if ctx.label == "parking":
            return AdaptiveThresholds(
                ttc_high_sec=0.5, ttc_med_sec=1.0,
                dist_high_m=0.8, dist_med_m=2.5,
            )
        # unknown — identical to detection.py defaults.
        return AdaptiveThresholds(
            ttc_high_sec=_DEFAULT_TTC_HIGH, ttc_med_sec=_DEFAULT_TTC_MED,
            dist_high_m=_DEFAULT_DIST_HIGH, dist_med_m=_DEFAULT_DIST_MED,
        )
