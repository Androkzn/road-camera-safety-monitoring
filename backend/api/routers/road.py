"""Road / multi-vehicle fleet aggregate routes.

Read-only views over ``road_registry`` (``backend.services.registry``) —
the in-process tally of every vehicle / driver seen by this edge node.
The registry is populated by ``emit_event`` each time a SafetyEvent is
published, keyed off the fleet-identity env vars (``ROAD_VEHICLE_ID`` /
``ROAD_ID`` / ``ROAD_DRIVER_ID``). Driver safety scores decay on the
interval set by ``ROAD_SCORE_DECAY_INTERVAL_SEC``.

UI connection
-------------
Page: None (operator/integration endpoints, not currently called from the React frontend).
UI element: No direct UI — fleet-summary / per-vehicle / driver-leaderboard
data intended for an external fleet dashboard or a future "fleet view"
page. A grep of ``frontend/src/**`` confirms no React code fetches
``/api/road/*`` today.
Backend route(s): GET /api/road/summary, GET /api/road/vehicle/{vehicle_id},
GET /api/road/drivers.
Backend services used: ``backend.services.registry.road_registry``.
"""

from fastapi import APIRouter, HTTPException

from backend.services.registry import road_registry

# ``APIRouter`` groups these related handlers.
router = APIRouter()


@router.get("/api/road/summary")
def api_road_summary():
    """System-wide aggregation: all vehicles, scores, event counts.

    HTTP: GET /api/road/summary
    Returns: dict with totals and a short per-vehicle list, exactly as
        produced by ``road_registry.road_summary()``.
    FE caller: none.
    Side effects: none (read-only).
    """
    return road_registry.road_summary()


# The ``{vehicle_id}`` segment is a PATH parameter — FastAPI binds it to
# the ``vehicle_id: str`` argument of the handler function.
@router.get("/api/road/vehicle/{vehicle_id}")
def api_road_vehicle(vehicle_id: str):
    """Fetch details for a single vehicle.

    HTTP: GET /api/road/vehicle/{vehicle_id}
    Path params:
        vehicle_id: the fleet vehicle id (matches ``ROAD_VEHICLE_ID`` on
            the edge node that produced the events).
    Returns: dict from ``road_registry.get_vehicle()`` — per-vehicle
        event counts, score, last-seen timestamp.
    FE caller: none.
    Side effects: none (read-only).
    Raises: 404 if the vehicle is not known to the registry.
    """
    v = road_registry.get_vehicle(vehicle_id)
    if v is None:
        raise HTTPException(404, "vehicle not found")
    return v


@router.get("/api/road/drivers")
def api_road_drivers(limit: int = 20):
    """Driver safety leaderboard (worst-first).

    HTTP: GET /api/road/drivers[?limit=<int>]
    Query params:
        limit: Max drivers returned (clamped at 100 server-side so a
            caller can't force the registry to rank its entire driver
            population in one shot).
    Returns: ``{"drivers": [driver_record, ...]}`` — already sorted
        worst-first by the registry.
    FE caller: none.
    Side effects: none (read-only).
    """
    return {"drivers": road_registry.driver_leaderboard(min(limit, 100))}
