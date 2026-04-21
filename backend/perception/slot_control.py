"""Per-slot lifecycle helpers: start / stop / pause / resume.

These wrap the ``StreamReader`` thread so routes + the lifespan hook can
drive a slot without knowing how the hot path is wired. The on-frame
callback is produced by :func:`make_on_frame`, which closes over the
perception hot path in :mod:`perception.on_frame`.

Extracted from ``server.py`` (step 7).

UI connection
-------------
Page: [AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx)
UI element: No direct UI — controls which camera slots are actively
       capturing frames at any moment. Its effect is what the operator
       sees on the Admin page's multi-source grid: starting a slot makes
       a new live tile appear (and start producing frames), stopping a
       slot freezes / removes that tile, pause / resume toggles whether
       the tile is updating.
Data flow: Operator clicks start/stop on a source -> /admin route calls
       start_slot() / stop_slot() -> StreamReader thread is spawned or
       killed -> live tile on AdminPage starts or stops receiving JPEGs
       via the /admin/frame polling endpoint.
"""

from backend.config import TARGET_FPS
from backend.core.stream import StreamReader, resolve_hls
from backend.logging import get_logger
from backend.perception.on_frame import make_on_frame
from backend.settings_store import STORE as SETTINGS_STORE
from backend.state import StreamSlot

log = get_logger(__name__)


def start_slot(slot: StreamSlot) -> None:
    """Resolve the slot's source URL and spawn its capture thread.

    Idempotent in spirit but assumes the caller has checked
    ``slot.is_running()`` and stopped any prior reader. On success,
    ``slot.reader`` is replaced with a freshly-started ``StreamReader``
    and ``slot.last_error`` is cleared.

    State transition: stopped -> running. This is the route path for
    ``POST /api/live/sources/{id}/start`` and the ``useStreamControl``
    hook on the frontend.

    Raises:
        RuntimeError / Exception from ``resolve_hls`` if the URL can't
        be resolved (yt-dlp failure, geo-block, signature change). The
        caller is expected to catch and surface the error back to the
        operator — slots without a resolvable URL shouldn't silently
        appear to start.
    """
    if not slot.original_source:
        raise RuntimeError(f"slot {slot.source_id} has no source URL")
    hls = resolve_hls(slot.original_source)
    live_fps = float(SETTINGS_STORE.snapshot().get("TARGET_FPS", TARGET_FPS))
    # Local-file sources loop forever by default so a local MP4 source
    # (typically used for testing) replays end-to-end. Live URLs
    # (YT/HLS/RTSP) keep the legacy "exit on EOF" behaviour.
    should_loop = slot.stream_type == "dashcam_file"
    reader = StreamReader(
        hls,
        target_fps=live_fps,
        original_source=slot.original_source,
        loop=should_loop,
    )
    reader.start(make_on_frame(slot))
    slot.reader = reader
    slot.last_error = None
    log.info(
        "slot %s started (source=%s, target_fps=%.1f)",
        slot.source_id,
        slot.original_source[:80],
        live_fps,
    )


def stop_slot(slot: StreamSlot) -> None:
    """Stop the slot's capture thread without dropping the slot.

    The slot stays in ``state.slots`` so the operator can restart it
    later. Per-source perception state (quality / scene / episodes)
    is intentionally NOT reset — restarting the same camera shouldn't
    re-learn its scene from scratch.

    State transition: running -> stopped. Backs ``POST /api/live/sources/{id}/stop``.
    Any in-flight episodes live inside ``slot.episodes`` and will be
    idle-flushed on the next successful start; we don't emit them here.
    """
    r = slot.reader
    if r is not None:
        try:
            r.stop()
        except Exception as exc:
            log.warning("slot %s stop failed: %s", slot.source_id, exc)
    slot.reader = None


def pause_slot(slot: StreamSlot) -> bool:
    """Freeze the slot's capture loop without tearing down the reader.

    Unlike :func:`stop_slot` this keeps ``slot.reader`` attached and its
    capture thread alive — for a local MP4 source that means playback
    position survives across a Pause → Start cycle so the operator
    resumes exactly where they paused instead of replaying from frame 0.

    State transition: running -> paused (reader thread still alive).
    Backs ``POST /api/live/sources/{id}/pause``. The ``detection`` toggle
    (handled inside on_frame via ``slot.detection_enabled``) is a separate
    axis: pause freezes the capture, detection-disable keeps capture
    running but skips the perception gates.

    Returns True when a reader was actually paused, False if the slot had
    nothing alive to pause (caller can treat that as a no-op).
    """
    r = slot.reader
    if r is None or r._thread is None or not r._thread.is_alive():
        return False
    r.pause()
    return True


def resume_slot(slot: StreamSlot) -> bool:
    """Reverse :func:`pause_slot`. Returns True when a paused reader was resumed.

    State transition: paused -> running. No-op (returns False) if the
    reader is missing or wasn't paused to begin with, so repeated resume
    calls are safe.
    """
    r = slot.reader
    if r is None or not r.is_paused():
        return False
    r.resume()
    return True
