"""Road / multi-vehicle fleet aggregate routes."""

from fastapi import APIRouter, HTTPException, Request

from road_safety.security.auth import require_admin
from road_safety.services.registry import road_registry

router = APIRouter()


@router.get("/api/road/summary")
def api_road_summary(request: Request):
    """System-wide aggregation: all vehicles, scores, event counts.

    HTTP: GET /api/road/summary
    AUTH: admin bearer
    """
    require_admin(request, "road summary")
    return road_registry.road_summary()


@router.get("/api/road/vehicle/{vehicle_id}")
def api_road_vehicle(request: Request, vehicle_id: str):
    """Fetch details for a single vehicle.

    HTTP: GET /api/road/vehicle/{vehicle_id}
    AUTH: admin bearer
    Raises: 404 if the vehicle is not known to the registry.
    """
    require_admin(request, "road vehicle detail")
    v = road_registry.get_vehicle(vehicle_id)
    if v is None:
        raise HTTPException(404, "vehicle not found")
    return v


@router.get("/api/road/drivers")
def api_road_drivers(request: Request, limit: int = 20):
    """Driver safety leaderboard (worst-first).

    HTTP: GET /api/road/drivers
    AUTH: admin bearer
    Query params:
        limit: Max drivers returned (capped at 100 server-side).
    """
    require_admin(request, "driver leaderboard")
    return {"drivers": road_registry.driver_leaderboard(min(limit, 100))}
