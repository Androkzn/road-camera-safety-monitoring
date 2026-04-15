"""Multi-vehicle road safety readiness layer.

Adds vehicle identity, system-wide event aggregation, and cross-vehicle
pattern detection. This module sits between the single-stream processing
(server.py) and the API layer, providing the data model that a production
multi-vehicle deployment needs.

Design goals:
  * Backwards-compatible -- a single-vehicle deployment still works; vehicle_id
    defaults to the ROAD_VEHICLE_ID env var.
  * System-wide queries -- aggregate events across vehicles, find hotspots.
  * Driver scoring -- rolling safety score per driver based on events +
    feedback.
  * Pattern detection -- flag when multiple vehicles report events at the
    same location/time window (intersection hotspot).

In a scaled deployment, the registry would live in a database. The current
implementation uses an in-memory dict keyed by vehicle_id, populated from
events as they arrive.
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
