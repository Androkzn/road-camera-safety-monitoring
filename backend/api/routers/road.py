"""Road / multi-vehicle fleet aggregate routes."""

from fastapi import APIRouter, HTTPException

from backend.services.registry import road_registry

router = APIRouter()


@router.get("/api/road/summary")
def api_road_summary():
    """System-wide aggregation: all vehicles, scores, event counts.

    HTTP: GET /api/road/summary
    """
    return road_registry.road_summary()


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

    HTTP: GET /api/road/drivers
    Query params:
        limit: Max drivers returned (capped at 100 server-side).
    """
    return {"drivers": road_registry.driver_leaderboard(min(limit, 100))}
