"""Per-caller token-bucket rate limit for annotated clip renders (BE-D14).

Applied ONLY to the cache-miss path so playback from cache is unthrottled.
Bucket: 3 tokens, refill 1 per 20s → sustained 3/min per caller.

Extracted from ``server.py`` as part of the refactor plan, step 2. Behaviour
unchanged — only the location.
"""

import hashlib
import threading
import time

from fastapi import HTTPException, Request

# Bucket parameters. Bumping these affects every clip-render caller, so
# change deliberately.
CLIP_BUCKET_CAP = 3
CLIP_BUCKET_REFILL_SEC = 20.0

_clip_buckets: dict[str, tuple[float, float]] = {}
_clip_bucket_lock = threading.Lock()


def clip_caller_key(request: Request) -> str:
    """Derive the rate-limit bucket key for a clip request.

    Prefers a SHA-256 hash of the bearer token (so different operators get
    independent buckets); falls back to ``request.client.host`` for
    unauthenticated callers during the ``REQUIRE_AUTH=False`` window.
    """
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        token = auth.split(None, 1)[1].strip()
        if token:
            digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]
            return f"bearer:{digest}"
    host = "unknown"
    try:
        if request.client and request.client.host:
            host = request.client.host
    except Exception:
        pass
    return f"ip:{host}"


def clip_rate_limit_check(request: Request) -> None:
    """Consume one token from the caller's clip-render bucket or raise 429.

    Call immediately before the expensive YOLO-annotated render. Cache hits
    should not invoke this — they serve from disk unthrottled.

    Raises:
        HTTPException: 429 when the bucket is empty.
    """
    key = clip_caller_key(request)
    now = time.time()
    with _clip_bucket_lock:
        tokens, last = _clip_buckets.get(key, (float(CLIP_BUCKET_CAP), now))
        # Refill: one token per ``CLIP_BUCKET_REFILL_SEC`` elapsed seconds,
        # capped at ``CLIP_BUCKET_CAP``. Fractional tokens are allowed so
        # callers don't bunch up at bucket boundaries.
        elapsed = max(0.0, now - last)
        tokens = min(float(CLIP_BUCKET_CAP), tokens + elapsed / CLIP_BUCKET_REFILL_SEC)
        if tokens < 1.0:
            _clip_buckets[key] = (tokens, now)
            raise HTTPException(
                429, "rate limit: too many annotated clip renders",
            )
        _clip_buckets[key] = (tokens - 1.0, now)
