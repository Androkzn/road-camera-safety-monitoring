"""POC: route auth wrappers are no-ops (stable signatures only)."""

from fastapi import Request

from backend.security import require_bearer_token


def require_admin(request: Request, realm: str = "admin") -> None:
    """POC: no enforcement."""
    require_bearer_token(request, None, realm=realm, env_var="")


def require_admin_if_flagged(request: Request, realm: str) -> None:
    """POC: no enforcement."""
    require_admin(request, realm=realm)
