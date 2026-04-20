"""Admin-bearer auth wrappers for the edge server's route handlers."""

from fastapi import Request

from backend.config import ADMIN_TOKEN
from backend.security import require_bearer_token


def require_admin(request: Request, realm: str = "admin") -> None:
    """Enforce the admin-bearer auth tier or raise 401.

    Wraps ``security.require_bearer_token`` with this module's constant
    admin token. Called at the top of every admin-tier endpoint.

    Args:
        request: The FastAPI request object (carries the Authorization header).
        realm: Human-readable label included in the 401 response so the
            UI can explain which scope was denied.

    Raises:
        HTTPException: 401 Unauthorized if the bearer token is missing
            or incorrect.
    """
    require_bearer_token(
        request,
        ADMIN_TOKEN,
        realm=realm,
        env_var="ROAD_ADMIN_TOKEN",
    )


def require_admin_if_flagged(request: Request, realm: str) -> None:
    """Enforce admin auth on routes that were formerly flag-gated.

    Historical behaviour allowed a release-window fallback controlled by
    ``ROAD_REQUIRE_AUTH``. Security hardening now enforces bearer auth
    unconditionally to avoid accidental perimeter-only deployments.

    Args:
        request: The FastAPI request (carries the Authorization header).
        realm: Short human-readable scope label; appears in 401 body and in
            logs for denied requests.
    """
    require_admin(request, realm=realm)
