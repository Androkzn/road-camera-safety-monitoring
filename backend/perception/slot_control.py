"""Per-slot lifecycle helpers: start / stop / pause / resume.

These wrap the ``StreamReader`` thread so routes + the lifespan hook can
drive a slot without knowing how the hot path is wired. The on-frame
callback is produced by :func:`make_on_frame`, which closes over the
perception hot path in :mod:`perception.on_frame`.

Extracted from ``server.py`` (step 7).
"""

from road_safety.config import TARGET_FPS
from road_safety.core.stream import StreamReader, resolve_hls
from road_safety.logging import get_logger
from road_safety.perception.on_frame import make_on_frame
from road_safety.settings_store import STORE as SETTINGS_STORE
from road_safety.state import StreamSlot

log = get_logger(__name__)


def start_slot(slot: StreamSlot) -> None:
    """Resolve the slot's source URL and spawn its capture thread.

    Idempotent in spirit but assumes the caller has checked
    ``slot.is_running()`` and stopped any prior reader. On success,
    ``slot.reader`` is replaced with a freshly-started ``StreamReader``
    and ``slot.last_error`` is cleared.

    Raises:
        RuntimeError / Exception from ``resolve_hls`` if the URL can't
        be resolved (yt-dlp failure, geo-block, signature change).
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

    Returns True when a reader was actually paused, False if the slot had
    nothing alive to pause (caller can treat that as a no-op).
    """
    r = slot.reader
    if r is None or r._thread is None or not r._thread.is_alive():
        return False
    r.pause()
    return True


def resume_slot(slot: StreamSlot) -> bool:
    """Reverse :func:`pause_slot`. Returns True when a paused reader was resumed."""
    r = slot.reader
    if r is None or not r.is_paused():
        return False
    r.resume()
    return True
