"""Per-IP token-bucket rate limit for annotated clip renders.

Applied ONLY to the cache-miss path so playback from cache is unthrottled.
Bucket: 3 tokens, refill 1 per 20s → sustained 3/min per caller IP.
"""

import threading
import time

from fastapi import HTTPException, Request

CLIP_BUCKET_CAP = 3
CLIP_BUCKET_REFILL_SEC = 20.0

_clip_buckets: dict[str, tuple[float, float]] = {}
_clip_bucket_lock = threading.Lock()


def clip_caller_key(request: Request) -> str:
    """Return a per-IP bucket key for clip-render rate limiting."""
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
    """
    key = clip_caller_key(request)
    now = time.time()
    with _clip_bucket_lock:
        tokens, last = _clip_buckets.get(key, (float(CLIP_BUCKET_CAP), now))
        elapsed = max(0.0, now - last)
        tokens = min(float(CLIP_BUCKET_CAP), tokens + elapsed / CLIP_BUCKET_REFILL_SEC)
        if tokens < 1.0:
            _clip_buckets[key] = (tokens, now)
            raise HTTPException(
                429, "rate limit: too many annotated clip renders",
            )
        _clip_buckets[key] = (tokens - 1.0, now)
