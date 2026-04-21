"""Per-source perception state.

A :class:`StreamSlot` bundles everything that is one-per-camera: the
:class:`~backend.core.stream.StreamReader`, the per-frame annotated JPEG
buffer used by the admin MJPEG/polling endpoints, and every per-source
perception estimator (quality, scene, ego, track history, episodes,
pair cooldown). Detected events land in the *shared*
``LiveState.recent_events`` buffer with ``source_id``/``source_name``
tags so downstream consumers (UI, Slack, cloud) can disambiguate.

Moved here from ``backend/state.py`` in the refactor that split domain
objects out of the state singleton; behaviour is unchanged.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any

from backend.config import camera_calibration_for
from backend.core.context import SceneContextClassifier
from backend.core.detection import TrackHistory
from backend.core.egomotion import EgoMotionEstimator
from backend.core.quality import QualityMonitor
from backend.core.stream import StreamReader, classify_source
from backend.domain.episode import Episode


class StreamSlot:
    """Per-source perception state.

    Each monitored stream gets its own slot bundling: the StreamReader,
    the per-frame annotated JPEG buffer, and every per-source perception
    object (quality, scene, ego, track history, episodes, pair cooldown).
    Detected events from this slot land in the SHARED ``state.recent_events``
    buffer with ``source_id`` / ``source_name`` tags so downstream
    consumers (UI, Slack, cloud) can disambiguate.

    Why per-slot for quality/scene/ego/episodes/pair_cooldown:
        These are stateful estimators whose output depends on a rolling
        window of frames from ONE camera. Sharing them across cameras
        would corrupt every estimate.

    Why shared for recent_events / subscribers / drift / publisher:
        These are pure aggregators / fan-outs — no per-source state to
        maintain. SSE clients want one merged stream, the cloud wants
        one HMAC-signed batch, drift is deployment-wide.
    """

    def __init__(self, source_id: str, name: str, original_source: str):
        self.source_id = source_id
        self.name = name
        # Per-camera calibration: focal length (px), mount height (m),
        # horizon fraction, orientation (forward/rear/side), and the
        # camera-to-body-edge offset along the optical axis. Resolved once
        # at slot construction from per-slot defaults + per-slot env
        # overrides (``ROAD_CAMERA_<FIELD>__<SLOT_ID>``). Frozen for the
        # lifetime of the slot so threads can read it without locks.
        # Threading the same calibration through every distance/TTC call
        # in this slot's perception loop is what makes a multi-camera
        # install (front 1× + rear 0.5× + left 0.5×) report accurate
        # distances per camera instead of pretending all three share the
        # front cam's intrinsics.
        self.calibration = camera_calibration_for(source_id)
        # Pre-resolution operator-supplied URL. The resolved URL (post
        # yt-dlp) is stashed on ``reader.source_url`` once started.
        self.original_source = original_source
        # UI-facing mode tag: "dashcam_file" (looping local MP4 source —
        # typically used for testing), "live_yt", "live_hls", "webcam",
        # "unknown". Drives the badge on the admin grid tile and whether
        # the reader loops on EOF.
        self.stream_type = classify_source(original_source)
        # ``None`` until the slot has been started at least once.
        self.reader: StreamReader | None = None
        # Most recent reason a start attempt failed (e.g. yt-dlp resolution
        # failure). Cleared on successful start. Surfaced over the API so
        # operators see *why* a stream is offline.
        self.last_error: str | None = None
        # Operator-controlled detection toggle. When False, ``_on_frame``
        # still renders the raw frame to the slot's MJPEG buffer (so the
        # operator can keep watching the camera) but skips YOLO,
        # quality / scene / ego updates, and event emission entirely. The
        # CPU saving is large; the trade-off is no boxes / no alerts from
        # this slot until re-enabled.
        self.detection_enabled: bool = True
        # Per-source perception estimators — fresh state machine per camera.
        self.track_history = TrackHistory()
        self.episodes: dict[tuple[int, int], Episode] = {}
        self.pair_cooldown: dict[tuple[int, int], float] = {}
        self.quality = QualityMonitor()
        self.last_perception_state: str | None = None
        # Thread the slot's camera calibration through the ego-motion estimator
        # so the pinhole speed-proxy uses the *correct* focal length + mount
        # height per slot (forward-facing 600px / 1.25m, rearward 260px / 1.10m,
        # sideways 260px / 1.00m). Also lets the estimator emit a signed
        # ``direction`` label which the orientation policy consumes to gate
        # rear-facing-camera events on observed reverse-direction scene flow.
        self.ego = EgoMotionEstimator(calibration=self.calibration)
        self.scene = SceneContextClassifier()
        self.last_ego_flow = None
        self.last_scene_ctx = None
        # Per-source MJPEG buffer. The capture thread writes; HTTP handlers
        # read. A dedicated lock per slot avoids cross-source contention.
        self._frame_lock = threading.Lock()
        self._annotated_jpeg: bytes | None = None
        self._frame_detections: list[dict] = []
        self._frame_ts: float = 0.0
        # Most-recent raw frame (BGR ndarray) captured for this slot. Used by
        # the polling endpoint as a fallback when ``_annotated_jpeg`` hasn't
        # been populated yet (e.g. first poll after stream start, or first
        # frame after a viewer-cycle). Storing the reference is O(1); we copy
        # only when we actually need to encode.
        self._latest_raw_frame = None
        # Active MJPEG viewer count. Incremented by ``_mjpeg_response`` on
        # connect and decremented in its ``finally`` block on disconnect.
        # When zero, ``_on_frame`` skips ``_render_annotated_frame`` /
        # ``cv2.imencode`` — the biggest per-frame cost after YOLO itself.
        self._mjpeg_subscribers: int = 0
        # Monotonic timestamp of the most recent poll to ``/admin/frame/{id}``.
        # The admin grid uses short-lived polls instead of a persistent MJPEG
        # connection (to dodge the browser's 6-conn-per-host cap), so viewer
        # presence has to be inferred from recent polls with a TTL.
        self._last_poll_monotonic: float = 0.0
        # ----- Per-stage latency ring buffers (BE-D5.A) -----
        # Populated by ``_on_frame`` / ``_flush_episode`` on the perception
        # thread; read by ``admin_health`` on the FastAPI thread pool. The
        # dedicated ``_stage_lock`` keeps us off the hot ``_frame_lock`` so
        # the health route never contends with the MJPEG encode path.
        # Each deque is bounded (``maxlen=200``) so the measurement path
        # is O(1) and memory stays flat regardless of runtime duration.
        self.stage_timings_ms: dict[str, deque] = {
            "yolo": deque(maxlen=200),
            "ego": deque(maxlen=200),
            "scene": deque(maxlen=200),
            "quality": deque(maxlen=200),
            "emit": deque(maxlen=200),
        }
        self._stage_lock = threading.Lock()

    def record_stage_ms(self, name: str, elapsed_ms: float) -> None:
        """Record a single stage latency sample.

        Called from the perception thread (``_on_frame``) and the emission
        path (``_flush_episode``). Thread-safe via ``_stage_lock``.
        """
        buf = self.stage_timings_ms.get(name)
        if buf is None:
            return
        with self._stage_lock:
            buf.append(elapsed_ms)

    def stage_stats(self) -> dict[str, dict]:
        """Return p50 / p95 / samples per stage for ``admin_health``.

        Snapshot is taken under ``_stage_lock`` and sorted outside the
        lock so the perception thread is blocked for as short a window
        as possible.
        """
        out: dict[str, dict] = {}
        with self._stage_lock:
            snapshots = {
                name: list(samples)
                for name, samples in self.stage_timings_ms.items()
            }
        for name, samples in snapshots.items():
            if not samples:
                out[name] = {"p50_ms": None, "p95_ms": None, "samples": 0}
                continue
            sorted_s = sorted(samples)
            n = len(sorted_s)
            p50 = sorted_s[n // 2]
            p95 = sorted_s[min(n - 1, int(n * 0.95))]
            out[name] = {
                "p50_ms": round(p50, 2),
                "p95_ms": round(p95, 2),
                "samples": n,
            }
        return out

    def has_viewers(self) -> bool:
        # Int read is atomic in CPython; a one-frame stale value is harmless
        # (at worst we skip one encode the frame a viewer connects on).
        if self._mjpeg_subscribers > 0:
            return True
        # Poll-based viewer: any /admin/frame hit in the last 2s counts. The
        # grid polls at ~400ms, so 2s = 5 polls of slack before we let the
        # encode path go idle (which matters on multi-stream hosts).
        return (time.monotonic() - self._last_poll_monotonic) < 2.0

    def mark_polled(self) -> None:
        self._last_poll_monotonic = time.monotonic()

    def _acquire_viewer(self) -> None:
        with self._frame_lock:
            self._mjpeg_subscribers += 1

    def _release_viewer(self) -> None:
        with self._frame_lock:
            self._mjpeg_subscribers = max(0, self._mjpeg_subscribers - 1)
            # Intentionally do NOT reset ``_annotated_jpeg`` here. Two reasons:
            #   1. The polling endpoint (``/admin/frame/{id}``) is a separate
            #      viewer path that doesn't increment ``_mjpeg_subscribers``;
            #      dropping the cached frame here strands every poll-based
            #      tile on the dark placeholder JPEG until the next
            #      perception tick (~0.5s) produces a fresh encode. With 6
            #      streams contending for the shared YOLO model the actual
            #      encode rate is closer to 0.5fps per slot, so the gap is
            #      visibly long.
            #   2. A stale-but-recent frame is strictly better UX than the
            #      placeholder JPEG. The next encode overwrites it anyway.

    def is_running(self) -> bool:
        # A paused reader is still "alive" (its capture thread is looping on
        # the pause gate) but from the UI's perspective it is not running —
        # frames are frozen, detection is off. Returning False while paused
        # keeps the Start/Pause toggle in sync with what the operator sees.
        return (
            self.reader is not None
            and self.reader._thread is not None
            and self.reader._thread.is_alive()
            and not self.reader.is_paused()
        )

    def status_dict(self) -> dict[str, Any]:
        """Public snapshot for ``/api/live/sources``."""
        q = self.quality.state()
        r = self.reader
        # Playback position: populated for looped local-file sources so the
        # frontend map overlay can sync its GPS marker to the MP4 loop. For
        # live feeds both numbers are 0.0 and the frontend falls back to a
        # wallclock loop.
        pos_sec, duration_sec = (
            r.playback_position() if r is not None else (0.0, 0.0)
        )
        return {
            "id": self.source_id,
            "name": self.name,
            "url": self.original_source,
            "stream_type": self.stream_type,
            "running": self.is_running(),
            "detection_enabled": self.detection_enabled,
            "last_error": self.last_error,
            "frames_read": r.frames_read if r else 0,
            "frames_processed": r.frames_processed if r else 0,
            "uptime_sec": round(r.uptime_sec(), 1) if r else 0.0,
            "playback_pos_sec": round(pos_sec, 2),
            "playback_duration_sec": round(duration_sec, 2),
            "started_at": r.started_at if r else None,
            "active_episodes": len(self.episodes),
            "perception_state": q.get("state"),
            "perception_reason": q.get("reason"),
        }
