"""Admin-bearer auth wrappers for the edge server's route handlers.

These are thin wrappers around :func:`road_safety.security.require_bearer_token`
that bake in the edge-server's admin token + env var name. They also implement
the BE-D12..D15 "flagged auth" pattern — when ``ROAD_REQUIRE_AUTH`` is off, the
server preserves pre-Sprint-0 public behaviour but logs a one-shot WARN per
``(route, realm)`` hit so operators see the "would have denied" signal before
the hard cutover flip.

Extracted from ``server.py`` as part of the refactor plan, step 2. Behaviour
unchanged.
"""

import threading

from fastapi import Request

from road_safety.config import ADMIN_TOKEN, REQUIRE_AUTH
from road_safety.logging import get_logger
from road_safety.security import require_bearer_token

log = get_logger(__name__)


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


# ─────────────────────────────────────────────────────────────────────────────
# BE-D12..D15 (Sprint 0 auth boundary) — helpers.
#
# The audit ships these endpoint-level hardenings behind a single env flag,
# ``ROAD_REQUIRE_AUTH`` (see ``config.REQUIRE_AUTH``). The flag is OFF in
# release N so ops can stamp a token into every deployment before the
# release N+1 flip to ON. The wrapper below is the single entry point so
# every hardened route uses the same policy.
# ─────────────────────────────────────────────────────────────────────────────


_auth_warn_seen: set[str] = set()
_auth_warn_lock = threading.Lock()


def require_admin_if_flagged(request: Request, realm: str) -> None:
    """Enforce admin auth on a previously-public endpoint, gated by ``REQUIRE_AUTH``.

    When ``config.REQUIRE_AUTH`` is False we fall through silently (preserving
    the pre-Sprint-0 behaviour) but log a rate-limited WARN the first time
    each ``(route, realm)`` pair is hit unauthenticated, so operators see the
    "would have denied" signal before the hard cutover flip. When
    ``REQUIRE_AUTH`` is True, delegates to ``require_admin`` which raises
    401/403 on missing/bad bearer.

    Args:
        request: The FastAPI request (carries the Authorization header).
        realm: Short human-readable scope label; appears in 401 body and in
            the one-shot WARN line so ops can grep for specific routes.
    """
    if REQUIRE_AUTH:
        require_admin(request, realm=realm)
        return
    # Flag off → preserve public behaviour, but emit a single WARN per
    # (route, realm) so untokenized deployments leave a breadcrumb before
    # the N+1 flip closes the door.
    auth_header = (request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer ") and ADMIN_TOKEN:
        # A token *was* presented even with flag off — honour it so admin
        # UIs that already send the header behave identically either side
        # of the flip. Any malformed / wrong token still raises 401.
        require_admin(request, realm=realm)
        return
    try:
        route_path = request.url.path
    except Exception:
        route_path = "<unknown>"
    key = f"{route_path}::{realm}"
    with _auth_warn_lock:
        if key in _auth_warn_seen:
            return
        _auth_warn_seen.add(key)
    log.warning(
        "auth_required_but_flag_off realm=%s route=%s "
        "(set ROAD_REQUIRE_AUTH=1 before the release-N+1 flip)",
        realm,
        route_path,
    )
