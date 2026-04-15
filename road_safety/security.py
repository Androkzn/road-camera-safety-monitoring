"""Shared request-auth helpers for sensitive operational endpoints."""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Request


def require_bearer_token(
    request: Request,
    token: str | None,
    *,
    realm: str,
    env_var: str,
) -> None:
    """Require an exact bearer token for a sensitive endpoint.

    If the deployment has not configured the token at all, the endpoint is
    treated as disabled rather than silently exposed.
    """
    if not token:
        raise HTTPException(
            503,
            f"{realm} access disabled — set {env_var} to enable this endpoint",
        )

    auth = (request.headers.get("Authorization") or "").strip()
    if not auth.startswith("Bearer "):
        raise HTTPException(401, f"missing bearer token for {realm} access")

    presented = auth[7:].strip()
    if not presented:
        raise HTTPException(401, f"missing bearer token for {realm} access")

    if not secrets.compare_digest(presented, token):
        raise HTTPException(403, f"invalid bearer token for {realm} access")
