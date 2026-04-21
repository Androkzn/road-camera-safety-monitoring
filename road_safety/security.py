"""security.py — tiny bearer-token gate for sensitive API endpoints.

What it does:
    Provides one helper, `require_bearer_token(...)`, that checks the
    `Authorization: Bearer <token>` header on an incoming HTTP request
    and either lets the request through or aborts with an HTTP error
    (401 missing, 403 invalid, 503 endpoint disabled).

Purpose:
    Protects operational endpoints that expose personal data or admin
    controls — the DSAR (data-subject-access-request) export used for
    GDPR compliance, and the admin API. Makes sure a random internet
    visitor cannot hit those routes.

How it works:
    `require_bearer_token(request, token, *, realm, env_var)` compares
    what the caller sent against the expected `token` loaded from env
    (typically `ROAD_ADMIN_TOKEN` or `ROAD_DSAR_TOKEN`). If the server
    was started without that env var set, the endpoint is treated as
    DISABLED rather than silently open — a fail-safe design. The `*` in
    the signature is a Python convention meaning "every argument after
    this must be passed by name" (so callers write `realm="admin"`, not
    a bare string). `secrets.compare_digest(...)` does a constant-time
    comparison — it avoids leaking how many characters of the token
    matched via timing side-channels. `HTTPException` comes from
    FastAPI; raising it aborts the request with the given status code
    and JSON body.

Connects to:
    - Backend: called from `server.py` route handlers (admin, DSAR,
      watchdog admin actions, etc.).
    - UI: none directly — but if a frontend page calls a protected
      endpoint without the header, it will receive the 401/403/503
      responses produced here.
"""

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
