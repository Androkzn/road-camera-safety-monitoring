"""On-demand annotated MP4 clip renderer for ``/api/events/{id}/clip``.

Builds a recognition-overlay clip: re-decodes the source MP4 in the event's
±N-second window, runs YOLO on each (sampled) frame, burns class-coloured
boxes in cv2, and pipes the BGR frames into ffmpeg for h264 encoding.
Heavy on first render, then cached on disk.

A SEPARATE YOLO instance is held here — we can't reuse ``state.model``
because the live ``_on_frame`` thread calls ``model.track(persist=True)``
and ByteTrack stores hidden state on the model; concurrent inference from
this path would corrupt live tracker ids.

Extracted from ``server.py`` as part of the refactor plan, step 3.
Behaviour unchanged.
"""

import threading
from pathlib import Path

import cv2

from road_safety.logging import get_logger

log = get_logger(__name__)


# Lazy second YOLO instance dedicated to clip annotation. We can't
# reuse ``state.model`` because the live ``_on_frame`` thread calls
# ``model.track(frame, persist=True, ...)``: ByteTrack stores hidden
# state on the model and concurrent inference from this thread would
# corrupt the live tracker IDs (and worst case crash on shared tensor
# buffers). A separate instance is the simple, correct fix.
_clip_model_lock = threading.Lock()
_clip_model = None  # type: ignore[var-annotated]


def get_clip_model():
    """Lazy-load a clip-only YOLO instance under a lock.

    Returns the model; raises whatever ``load_model`` raises on failure
    (caller catches and falls back to raw ffmpeg cut).
    """
    global _clip_model
    with _clip_model_lock:
        if _clip_model is None:
            from road_safety.core.detection import load_model
            _clip_model = load_model()
        return _clip_model


# Class palette for the annotated clip — same colours as the live admin
# tile (see ``rendering/frame.py::render_annotated_frame.color_map``) so
# reviewers get visual continuity between the two surfaces.
CLIP_COLOR_MAP: dict[str, tuple[int, int, int]] = {
    "person": (0, 220, 100),
    "car": (255, 160, 0),
    "truck": (255, 100, 0),
    "bus": (200, 80, 200),
    "motorcycle": (0, 180, 255),
    "bicycle": (0, 180, 255),
}


def draw_clip_overlay(frame, detections):
    """Draw class-coloured bboxes + labels on a copy of ``frame``.

    Args:
        frame: BGR ndarray.
        detections: iterable of ``Detection`` objects.

    Returns:
        BGR ndarray of the same shape with overlays burned in.
    """
    out = frame.copy()
    for det in detections:
        color = CLIP_COLOR_MAP.get(det.cls, (200, 200, 200))
        cv2.rectangle(out, (det.x1, det.y1), (det.x2, det.y2), color, 2)
        label = f"{det.cls} {det.conf:.0%}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(
            out, (det.x1, det.y1 - th - 6), (det.x1 + tw + 4, det.y1), color, -1,
        )
        cv2.putText(
            out, label, (det.x1 + 2, det.y1 - 4),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA,
        )
    return out


def render_annotated_event_clip(
    source_path: Path,
    start_sec: float,
    duration_sec: float,
    out_path: Path,
) -> None:
    """Render an annotated MP4 from ``source_path`` over the given window.

    Decodes frames with cv2, runs YOLO at a throttled cadence (re-using
    the previous detection between detect ticks so playback stays smooth
    without paying full per-frame inference cost), burns class-coloured
    bboxes, and pipes raw BGR frames to ``ffmpeg`` for h264+faststart
    encoding. Output is written atomically: a sibling ``.tmp`` file is
    fully encoded then renamed to ``out_path``, so a partially-written
    clip never gets cached after a crash mid-render.

    Args:
        source_path: Local MP4 to read.
        start_sec: Seek offset in seconds.
        duration_sec: Clip length in seconds.
        out_path: Destination MP4. Parent must exist.

    Raises:
        FileNotFoundError: ``ffmpeg`` binary missing.
        RuntimeError: source could not be opened, or ffmpeg returned
            non-zero (caller falls back to raw cut).
        subprocess.TimeoutExpired: ffmpeg encode exceeded the 60s budget.
    """
    import subprocess

    from road_safety.core.detection import detect_frame

    cap = cv2.VideoCapture(str(source_path))
    if not cap.isOpened():
        raise RuntimeError(f"could not open source video: {source_path}")
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    proc: "subprocess.Popen | None" = None
    try:
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if width <= 0 or height <= 0:
            raise RuntimeError("source video reported zero frame size")
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, start_sec) * 1000.0)

        # Cap output fps so a long clip-render time stays bounded. 12 fps
        # is smooth enough for review video and ~2-3x cheaper than the
        # typical 24-30 fps source.
        out_fps = min(src_fps, 12.0)
        # Run YOLO every Nth source frame and carry boxes forward in
        # between. ~4 fps detection cadence matches the live admin tile
        # (TARGET_FPS) so the on-screen overlay updates at the same
        # rhythm reviewers are used to from the live feed.
        detect_every = max(1, int(round(src_fps / 4.0)))
        # Frame-emit step — we sample every ``out_step``-th source frame
        # to map ``src_fps`` down to ``out_fps`` without re-encoding the
        # decoded stream twice.
        out_step = src_fps / out_fps if out_fps > 0 else 1.0
        end_sec = max(0.0, start_sec) + max(0.0, duration_sec)

        proc = subprocess.Popen(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "rawvideo", "-pix_fmt", "bgr24",
                "-s", f"{width}x{height}",
                "-r", f"{out_fps:.3f}",
                "-i", "pipe:",
                "-c:v", "libx264", "-preset", "veryfast",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-an",
                # Force MP4 muxer explicitly — ffmpeg can't infer format
                # from the ``.mp4.tmp`` suffix (it picks muxer by extension
                # and ``.tmp`` is unknown), so without ``-f mp4`` the encode
                # fails with "Invalid argument" before a single frame lands.
                "-f", "mp4",
                str(tmp_path),
            ],
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert proc.stdin is not None  # mypy/runtime guard

        model = get_clip_model()
        last_dets: list = []
        frame_idx = 0
        next_emit = 0.0
        emitted = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            pos_sec = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if pos_sec >= end_sec:
                break
            if frame_idx % detect_every == 0:
                try:
                    last_dets = detect_frame(model, frame, persistent=False)
                except Exception as exc:  # noqa: BLE001
                    # Detection failure on one frame must not abort the
                    # clip — keep the previous boxes (or none) so the
                    # reviewer at least gets the source pixels.
                    log.debug("clip annotator: detect_frame failed: %s", exc)
            if frame_idx >= next_emit:
                annotated = draw_clip_overlay(frame, last_dets)
                try:
                    proc.stdin.write(annotated.tobytes())
                except BrokenPipeError:
                    # ffmpeg died mid-encode — surface as RuntimeError so
                    # the route handler falls back to the raw ffmpeg cut.
                    break
                emitted += 1
                next_emit += out_step
            frame_idx += 1

        proc.stdin.close()
        proc.wait(timeout=60)
        if proc.returncode != 0:
            err = b""
            if proc.stderr is not None:
                err = proc.stderr.read() or b""
            raise RuntimeError(
                f"ffmpeg returned {proc.returncode}: "
                f"{err.decode('utf-8', errors='replace')[-400:]}"
            )
        if emitted == 0:
            raise RuntimeError(
                "no frames emitted (event timestamp outside source duration?)"
            )
        # Atomic publish — readers either see the fully-encoded clip or
        # nothing at all. ``Path.replace`` is atomic on POSIX.
        tmp_path.replace(out_path)
    finally:
        cap.release()
        if proc is not None and proc.stdin is not None and not proc.stdin.closed:
            try:
                proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        # Clean up partial tmp on any error path so the next request
        # re-renders fresh instead of hitting a corrupt cache.
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
