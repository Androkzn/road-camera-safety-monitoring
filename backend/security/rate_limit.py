"""Per-IP token-bucket rate limit for annotated clip renders.

Applied ONLY to the cache-miss path so playback from cache is unthrottled.
Bucket: 3 tokens, refill 1 per 20s -> sustained 3/min per caller IP.

Token-bucket algorithm (for readers new to rate-limiting)
---------------------------------------------------------
Each caller has a virtual "bucket" that holds up to ``CLIP_BUCKET_CAP``
tokens. Every request consumes one token; tokens refill continuously at
``1 / CLIP_BUCKET_REFILL_SEC`` per second. When the bucket is empty the
request is rejected (HTTP 429). This lets us tolerate short bursts up to
the cap while enforcing a sustained average rate over time.

Python concept — ``fastapi.Request``:
    A dependency-injected object representing the inbound HTTP request.
    Route handlers that accept a ``Request`` parameter get one passed in
    automatically by FastAPI.

Python concept — ``threading.Lock``:
    A mutex. Only one thread at a time can be inside the ``with lock:``
    block. We need this because FastAPI serves requests on a thread pool
    and the shared ``_clip_buckets`` dict is not atomic.

UI connection
-------------
Page: AdminPage
UI element: No direct UI — protects the ``/api/road/clip`` endpoint that
       serves event-playback clips opened from the AdminPage event cards.
"""

# ``threading`` — standard-library thread coordination primitives.
# ``time``      — monotonic-ish wall-clock used for bucket accounting.
import threading
import time

# ``HTTPException`` — raise this to send a specific HTTP error response;
# FastAPI converts it into the proper status + JSON body.
from fastapi import HTTPException, Request

# Maximum tokens in a single caller's bucket. Acts as the burst allowance:
# a fresh caller can render up to 3 clips back-to-back before throttling.
CLIP_BUCKET_CAP = 3
# Seconds between token refills. 20s => 1 token every 20s => 3 per minute
# sustained after the initial burst is used up.
CLIP_BUCKET_REFILL_SEC = 20.0

# Per-caller bucket state keyed by IP. Tuple is ``(tokens, last_update_ts)``
# — how many tokens the caller currently has and when we last recalculated.
# ``dict[str, tuple[float, float]]`` is a type hint: "dict mapping str keys
# to (float, float) value tuples".
_clip_buckets: dict[str, tuple[float, float]] = {}
# Module-level lock protecting the shared dict.
_clip_bucket_lock = threading.Lock()


def clip_caller_key(request: Request) -> str:
    """Return a per-IP bucket key for clip-render rate limiting.

    Keys are namespaced with an ``ip:`` prefix so future additions (e.g.
    per-user buckets) can coexist in the same dict without collision.
    """
    host = "unknown"
    try:
        # ``request.client`` can be None (ASGI implementations are free to
        # omit it); guard with a truthy check and fall back to "unknown".
        if request.client and request.client.host:
            host = request.client.host
    except Exception:
        # Never let the key-derivation crash the request — being permissive
        # here means an attacker at worst ends up in the "unknown" bucket
        # (still rate-limited, just shared).
        pass
    # f-string: embed ``host`` into the key. ``f"ip:{host}"`` is equivalent
    # to ``"ip:" + host`` but clearer.
    return f"ip:{host}"


def clip_rate_limit_check(request: Request) -> None:
    """Consume one token from the caller's clip-render bucket or raise 429.

    Call immediately before the expensive YOLO-annotated render. Cache hits
    should not invoke this — they serve from disk unthrottled.

    How it works:
        1. Look up (or seed) the caller's ``(tokens, last_update)`` pair.
        2. Compute how many tokens should have refilled since ``last_update``.
        3. Add those tokens to the bucket (capped at ``CLIP_BUCKET_CAP``).
        4. If less than 1 token is available, reject with HTTP 429.
        5. Otherwise deduct 1 and store the new state back in the dict.

    Raises:
        HTTPException: status 429 when the bucket is empty. FastAPI turns
            this into a JSON response for the client.
    """
    key = clip_caller_key(request)
    now = time.time()
    # ``with lock:`` acquires the lock on entry and releases it on exit,
    # even if an exception is raised inside the block.
    with _clip_bucket_lock:
        # ``dict.get(key, default)`` returns the value if present, else the
        # default. A brand-new caller starts with a full bucket.
        tokens, last = _clip_buckets.get(key, (float(CLIP_BUCKET_CAP), now))
        elapsed = max(0.0, now - last)
        # Refill math: ``elapsed / REFILL_SEC`` tokens accrued since last
        # check; ``min(...)`` caps at the bucket size.
        tokens = min(float(CLIP_BUCKET_CAP), tokens + elapsed / CLIP_BUCKET_REFILL_SEC)
        if tokens < 1.0:
            # Still remember the refilled balance so the caller's next try
            # in a moment sees accurate accounting.
            _clip_buckets[key] = (tokens, now)
            raise HTTPException(
                429, "rate limit: too many annotated clip renders",
            )
        # Happy path — debit one token and persist.
        _clip_buckets[key] = (tokens - 1.0, now)
