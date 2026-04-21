"""registry.py — in-memory fleet, vehicle, and driver bookkeeping.

What it does:
    Keeps a running tally of every vehicle the system has seen and how
    many safety events each one has triggered. Maintains a rolling
    "safety score" per vehicle (starts at 100, drops when events fire,
    slowly recovers over time) plus per-driver leaderboards and a
    road-wide summary.

Purpose:
    The raw event stream doesn't answer fleet-level questions like
    "which driver is riskiest this week?" or "how many events did
    vehicle X generate?". This module aggregates events into that
    higher-level view for the dashboard without needing a database.

How it works:
    * ``@dataclass`` on ``VehicleState`` auto-generates ``__init__`` and
      field storage from type annotations — treat it as a typed record.
    * ``field(default_factory=lambda: {...})`` gives each new vehicle
      its own fresh counters dict (not a shared one across all vehicles,
      which would be a classic Python bug).
    * All state lives in one module-level ``road_registry`` object,
      which is a plain in-memory dict keyed by ``vehicle_id``. Restarting
      the server resets it — in a scaled deployment this would move to a
      database.
    * ``record_event`` bumps counters and deducts from the safety score
      based on risk weight; ``decay_scores`` slowly restores points over
      time; ``road_summary`` and ``driver_leaderboard`` produce the
      shapes the API returns.
    * Defaults (``VEHICLE_ID``, ``ROAD_ID``, ``DRIVER_ID``) come from
      environment variables via ``road_safety.config``.

Connects to:
    - Backend: ``road_safety/server.py`` imports ``road_registry`` and
      calls ``record_event``/``record_feedback`` from the detection
      pipeline. Exposes ``/api/road/summary``,
      ``/api/road/vehicle/{vehicle_id}``, and ``/api/road/drivers``.
    - UI: none currently — the road/drivers endpoints are not yet wired
      into ``frontend/src/lib/api.ts``; visible only via direct API
      calls or future fleet pages.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from road_safety.config import DRIVER_ID, ROAD_ID, VEHICLE_ID

RISK_WEIGHTS = {"high": 10, "medium": 3, "low": 1}
SCORE_DECAY_PER_HOUR = 0.5
MAX_SCORE = 100.0


@dataclass
class VehicleState:
    vehicle_id: str
    road_id: str
    driver_id: str | None = None
    total_events: int = 0
    events_by_risk: dict[str, int] = field(default_factory=lambda: {"high": 0, "medium": 0, "low": 0})
    events_by_type: dict[str, int] = field(default_factory=dict)
    last_event_ts: float | None = None
    safety_score: float = MAX_SCORE
    feedback_tp: int = 0
    feedback_fp: int = 0

    def as_dict(self) -> dict:
        return {
            "vehicle_id": self.vehicle_id,
            "road_id": self.road_id,
            "driver_id": self.driver_id,
            "total_events": self.total_events,
            "events_by_risk": dict(self.events_by_risk),
            "events_by_type": dict(self.events_by_type),
            "last_event_ts": self.last_event_ts,
            "safety_score": round(self.safety_score, 1),
            "feedback_tp": self.feedback_tp,
            "feedback_fp": self.feedback_fp,
            "precision": round(
                self.feedback_tp / max(self.feedback_tp + self.feedback_fp, 1), 3
            ),
        }


class RoadRegistry:
    """In-memory vehicle registry for multi-vehicle aggregation."""

    def __init__(self):
        self._vehicles: dict[str, VehicleState] = {}
        self._event_locations: list[dict] = []

    def _ensure(self, vehicle_id: str, road_id: str = ROAD_ID, driver_id: str | None = None) -> VehicleState:
        if vehicle_id not in self._vehicles:
            self._vehicles[vehicle_id] = VehicleState(
                vehicle_id=vehicle_id, road_id=road_id, driver_id=driver_id,
            )
        return self._vehicles[vehicle_id]

    def record_event(self, event: dict) -> None:
        vid = event.get("vehicle_id", VEHICLE_ID)
        rid = event.get("road_id", ROAD_ID)
        did = event.get("driver_id", DRIVER_ID)
        v = self._ensure(vid, rid, did)

        v.total_events += 1
        risk = event.get("risk_level", "low")
        v.events_by_risk[risk] = v.events_by_risk.get(risk, 0) + 1
        etype = event.get("event_type", "unknown")
        v.events_by_type[etype] = v.events_by_type.get(etype, 0) + 1
        v.last_event_ts = time.time()

        penalty = RISK_WEIGHTS.get(risk, 1)
        v.safety_score = max(0.0, v.safety_score - penalty)

    def record_feedback(self, event_id: str, verdict: str, vehicle_id: str | None = None) -> None:
        vid = vehicle_id or VEHICLE_ID
        v = self._ensure(vid)
        if verdict == "tp":
            v.feedback_tp += 1
        elif verdict == "fp":
            v.feedback_fp += 1

    def decay_scores(self) -> None:
        """Call periodically to let safety scores recover over time."""
        for v in self._vehicles.values():
            v.safety_score = min(MAX_SCORE, v.safety_score + SCORE_DECAY_PER_HOUR)

    def get_vehicle(self, vehicle_id: str) -> dict | None:
        v = self._vehicles.get(vehicle_id)
        return v.as_dict() if v else None

    def road_summary(self) -> dict[str, Any]:
        vehicles = list(self._vehicles.values())
        if not vehicles:
            return {
                "road_id": ROAD_ID,
                "vehicle_count": 0,
                "total_events": 0,
                "aggregate_by_risk": {},
                "aggregate_by_type": {},
                "lowest_score_vehicle": None,
                "vehicles": [],
            }

        agg_risk: dict[str, int] = defaultdict(int)
        agg_type: dict[str, int] = defaultdict(int)
        total = 0
        for v in vehicles:
            total += v.total_events
            for k, c in v.events_by_risk.items():
                agg_risk[k] += c
            for k, c in v.events_by_type.items():
                agg_type[k] += c

        worst = min(vehicles, key=lambda v: v.safety_score)

        return {
            "road_id": ROAD_ID,
            "vehicle_count": len(vehicles),
            "total_events": total,
            "aggregate_by_risk": dict(agg_risk),
            "aggregate_by_type": dict(agg_type),
            "lowest_score_vehicle": {
                "vehicle_id": worst.vehicle_id,
                "safety_score": round(worst.safety_score, 1),
                "driver_id": worst.driver_id,
            },
            "vehicles": [v.as_dict() for v in sorted(vehicles, key=lambda v: v.safety_score)],
        }

    def driver_leaderboard(self, limit: int = 20) -> list[dict]:
        """Rank drivers by safety score (ascending = worst first)."""
        drivers: dict[str, dict] = {}
        for v in self._vehicles.values():
            did = v.driver_id or v.vehicle_id
            if did not in drivers:
                drivers[did] = {
                    "driver_id": did,
                    "vehicles": [],
                    "total_events": 0,
                    "high_risk_events": 0,
                    "safety_score": MAX_SCORE,
                }
            d = drivers[did]
            d["vehicles"].append(v.vehicle_id)
            d["total_events"] += v.total_events
            d["high_risk_events"] += v.events_by_risk.get("high", 0)
            d["safety_score"] = min(d["safety_score"], v.safety_score)

        ranked = sorted(drivers.values(), key=lambda d: d["safety_score"])
        return ranked[:limit]


road_registry = RoadRegistry()
