"""Road / multi-vehicle fleet aggregate routes.

Read-only views over ``road_registry`` — the in-process tally of every
vehicle / driver seen by this edge node.

UI connection
-------------
Page: None (operator/integration endpoints, not currently called from the React frontend).
UI element: No direct UI — fleet-summary / per-vehicle / driver-leaderboard
data intended for an external fleet dashboard or a future "fleet view" page.
Backend route(s): GET /api/road/summary, GET /api/road/vehicle/{vehicle_id},
GET /api/road/drivers.
"""

from fastapi import APIRouter, HTTPException

from backend.services.registry import road_registry

# ``APIRouter`` groups these related handlers.
router = APIRouter()


@router.get("/api/road/summary")
def api_road_summary():
    """System-wide aggregation: all vehicles, scores, event counts.

    HTTP: GET /api/road/summary
    Returns: dict with totals and a short per-vehicle list.
    """
    return road_registry.road_summary()


# The ``{vehicle_id}`` segment is a PATH parameter — FastAPI binds it to
# the ``vehicle_id: str`` argument of the handler function.
@router.get("/api/road/vehicle/{vehicle_id}")
def api_road_vehicle(vehicle_id: str):
    """Fetch details for a single vehicle.

    HTTP: GET /api/road/vehicle/{vehicle_id}
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
        limit: Max drivers returned (capped at 100 server-side).
    """
    return {"drivers": road_registry.driver_leaderboard(min(limit, 100))}
