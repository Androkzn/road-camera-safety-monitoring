"""HMAC-signed URL helpers for thumbnails + media streams.

Three token families, all keyed on ``THUMB_SIGNING_SECRET``:

* ``thumb_token`` — public thumbnail downloads, 24h cap.
* ``media_token`` — live MJPEG / polling-frame / detection-SSE, 5 min cap.
* ``require_media_auth`` — enforcement entry point: accept a signed URL OR
  fall back to ``require_admin_if_flagged``.

Extracted from ``server.py`` as part of the refactor plan, step 2. Behaviour
unchanged — only the location.
"""

import hashlib
import hmac
import time

from fastapi import Request

from backend.config import PUBLIC_THUMBS_REQUIRE_TOKEN, THUMB_SIGNING_SECRET
from backend.security.auth import require_admin_if_flagged

# ─── BE-D13: short-lived signed URLs for media/detection streams ────────────
# The existing ``thumb_token`` primitive already HMAC-signs a name + expiry
# pair. Media URLs reuse the same secret (``THUMB_SIGNING_SECRET``) but with
# a composite key ``"<stream>:<source_id>"`` so a leaked thumbnail token
# can't be replayed against the live video feed and vice-versa. TTL is
# tighter (5 min) because the mint endpoint is auth-gated and the FE should
# refresh before expiry.

MEDIA_TOKEN_TTL_SEC = 5 * 60


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
    # Reject far-future signatures in case of leaked URLs.
    # WHY 24h: a leaked URL with a 30-day expiry is a de facto permanent
    # bypass; capping exposure at ~1 day limits blast radius.
    if exp > now + (24 * 60 * 60):
        return False
    expected = thumb_token(name, exp)
    # ``hmac.compare_digest`` is constant-time — prevents timing-oracle
    # attacks that would otherwise leak the correct token byte-by-byte.
    return hmac.compare_digest(expected, token)


def media_token(stream_key: str, expiry: int) -> str:
    """HMAC-sign ``(stream_key, expiry)`` for a media-stream URL.

    Args:
        stream_key: Composite key ``"<stream>:<source_id>"`` where
            ``stream`` is one of ``"mjpeg"``, ``"frame"``, ``"detections"``.
        expiry: Unix-epoch second the token stops being valid.

    Returns:
        The first 32 hex chars of a SHA-256 HMAC. Same entropy envelope as
        ``thumb_token``.
    """
    mac = hmac.new(
        THUMB_SIGNING_SECRET.encode("utf-8"),
        f"media:{stream_key}.{expiry}".encode("utf-8"),
        hashlib.sha256,
    )
    return mac.hexdigest()[:32]


def valid_media_request(stream_key: str, request: Request) -> bool:
    """Validate the signed-URL ``?exp=&token=`` pair on a media endpoint.

    Mirrors ``valid_thumb_request`` but with a 5-minute exp cap (vs 24h on
    thumbnails) because live-video signatures are higher-value.

    Args:
        stream_key: Composite ``"<stream>:<source_id>"`` key.
        request: FastAPI request object — reads ``exp`` / ``token``.

    Returns:
        ``True`` iff ``THUMB_SIGNING_SECRET`` is configured, the request
        carries both ``exp`` + ``token``, the expiry is in the future but
        no more than ``MEDIA_TOKEN_TTL_SEC`` ahead, and the HMAC matches.
    """
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
    if exp > now + MEDIA_TOKEN_TTL_SEC:
        return False
    expected = media_token(stream_key, exp)
    return hmac.compare_digest(expected, token)


def require_media_auth(stream_key: str, request: Request, realm: str) -> None:
    """Enforce media-stream auth: signed URL, admin bearer, or public fall-through.

    When ``REQUIRE_AUTH`` is True: accept a valid HMAC-signed URL OR an
    admin bearer token; reject everything else with 401.

    When ``REQUIRE_AUTH`` is False: preserve the pre-Sprint-0 public
    behaviour but emit a rate-limited WARN on the first unauthenticated
    hit so ops can spot untokenized deployments before the flip.

    Args:
        stream_key: ``"<stream>:<source_id>"`` used for signature validation.
        request: FastAPI request.
        realm: Short label for the 401 body / WARN line (e.g. ``"media:mjpeg"``).
    """
    # Signed URL? Accept regardless of flag — mint endpoint is auth-gated,
    # so presenting a valid signature is proof the caller has been through
    # the admin path once.
    if valid_media_request(stream_key, request):
        return
    require_admin_if_flagged(request, realm=realm)
