"""HMAC-signed URL helpers for thumbnails.

POC deployments leave live media routes open (no signed media URLs). Only
public thumbnail signing remains when ``PUBLIC_THUMBS_REQUIRE_TOKEN`` is on.
"""

import hashlib
import hmac
import time

from fastapi import Request

from backend.config import PUBLIC_THUMBS_REQUIRE_TOKEN, THUMB_SIGNING_SECRET


def thumb_token(name: str, expiry: int) -> str:
    """Produce a 32-hex-char HMAC tag binding ``name`` to an expiry time.

    Args:
        name: Thumbnail filename (e.g. ``evt_1234_0001_public.jpg``).
        expiry: Unix-epoch second at which this token stops being valid.

    Returns:
        The first 32 hex characters of the SHA-256 HMAC. 128 bits is more
        than enough entropy for a short-lived signed URL.
    """
    mac = hmac.new(
        THUMB_SIGNING_SECRET.encode("utf-8"),
        f"{name}.{expiry}".encode("utf-8"),
        hashlib.sha256,
    )
    return mac.hexdigest()[:32]


def valid_thumb_request(name: str, request: Request) -> bool:
    """Check whether the signed-URL query params on a public-thumb fetch are valid.

    Args:
        name: Thumbnail filename from the URL path.
        request: The FastAPI request (to read ``?exp=`` + ``?token=``).

    Returns:
        True iff:
          * Token-gating is disabled entirely via config, OR
          * A signing secret is configured, AND the request carries
            ``exp`` + ``token`` query params, AND ``exp`` is in the
            future (but not more than 24h ahead), AND the HMAC matches.
    """
    if not PUBLIC_THUMBS_REQUIRE_TOKEN:
        return True
    if not THUMB_SIGNING_SECRET:
        return False
    exp_raw = request.query_params.get("exp")
    token = (request.query_params.get("token") or "").strip()
    if not exp_raw or not token:
        return False
    try:
        exp = int(exp_raw)
    except ValueError:
        return False
    now = int(time.time())
    if exp < now:
        return False
    if exp > now + (24 * 60 * 60):
        return False
    expected = thumb_token(name, exp)
    return hmac.compare_digest(expected, token)


def require_media_auth(stream_key: str, request: Request, realm: str) -> None:
    """POC: no media auth — signature preserved for call sites."""
    del stream_key, request, realm
    return
