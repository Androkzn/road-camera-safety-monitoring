"""Centralised configuration — all paths, env vars, and constants.

================================================================================
THIS IS THE SINGLE SOURCE OF TRUTH FOR PATHS AND ENVIRONMENT SETTINGS.
Do not compute paths (no ``Path(__file__).parent`` in other modules) and do
not read ``os.environ`` directly elsewhere. Every module in the project
imports the names it needs from this file, which means:

    * The directory layout can be moved without grepping the codebase.
    * Environment-variable names are documented and discoverable in one place.
    * Tests and tooling can monkey-patch configuration by reloading this
      module instead of chasing local copies.
================================================================================

Role:
    Collects every deployment-tunable knob (paths, network ports, privacy
    tokens, camera calibration, LLM settings, ...) into one module that runs
    exactly once at import time. Values are captured into plain module-level
    constants so callers can ``from backend.config import TARGET_FPS``
    and get a stable value.

Import-time behaviour:
    * Locates ``PROJECT_ROOT`` from this file's location.
    * Loads ``.env`` (if present) so env vars work both in shells and via
      ``python-dotenv``-style dev workflows.
    * Reads all documented env vars; missing values fall back to safe
      defaults unless the variable is security-critical (tokens, HMAC
      secrets) in which case the consumer is expected to fail closed.

Python concept — ``os.environ``:
    A process-global ``dict`` of environment variables. ``os.getenv(name,
    default)`` is the standard read helper: returns the string value if set,
    otherwise returns ``default``. Env vars are always strings, which is why
    numeric settings below explicitly cast with ``int(...)`` / ``float(...)``.

Python concept — ``pathlib.Path``:
    Object-oriented filesystem paths. ``Path("/a") / "b"`` produces
    ``Path("/a/b")`` regardless of OS. ``.parent`` / ``.resolve()`` replace
    the older ``os.path`` string manipulation.

UI connection
-------------
Page: none directly.
UI element: No direct UI — central settings module. Everything in the app reads paths and environment from here, including the backend that serves the UI.
"""

from __future__ import annotations

# Stdlib imports only plus ``python-dotenv`` for the ``.env`` loader. No
# project imports — this module sits at the bottom of the dependency graph.
import os
import secrets
from dataclasses import dataclass, replace
from pathlib import Path

from dotenv import load_dotenv

# ─────────────────────────────────────────────────────────────────────────────
# Section: PROJECT ROOT AND DIRECTORY LAYOUT
# ─────────────────────────────────────────────────────────────────────────────
# Project root is the parent of the ``backend/`` package directory.
# ``Path(__file__)``        → absolute path to this config.py
# ``.resolve()``            → canonicalise (follow symlinks, make absolute)
# ``.parent``               → the ``backend/`` directory
# ``.parent`` (again)       → the project root (where ``pyproject.toml`` lives)
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Load the project's ``.env`` file (if present) *before* any ``os.getenv``
# call below. Dotenv reads the file and injects key=value pairs into
# ``os.environ`` as if they had been exported in the shell. Real shell env
# vars always win — dotenv never overwrites an already-set variable.
load_dotenv(PROJECT_ROOT / ".env")

# Runtime data lives under ``data/``:
#   - ``thumbnails/`` — both redacted (public) and unredacted thumbs.
#   - ``corpus/``     — saved reference events for replay / regression.
#   - ``cloud.db``    — separate DB used by ``cloud/receiver.py`` (not here).
DATA_DIR = PROJECT_ROOT / "data"
THUMBS_DIR = DATA_DIR / "thumbnails"

# Frontend serving strategy: serve the built React bundle from
# ``frontend/dist/``. The launcher (``start.py``) builds it before starting
# uvicorn. If the directory is missing, the static-files mount in
# ``server.py`` will fail at boot — fail loud rather than serving a stale
# fallback.
STATIC_DIR = PROJECT_ROOT / "frontend" / "dist"

CORPUS_DIR = DATA_DIR / "corpus"

# ─────────────────────────────────────────────────────────────────────────────
# Section: PERCEPTION BINARIES (YOLO, yt-dlp)
# ─────────────────────────────────────────────────────────────────────────────
# Path to the YOLOv8 weights file. Override ``ROAD_MODEL_PATH`` when swapping
# to a custom-trained detector or a larger variant (yolov8s/m/l). Default
# ``yolov8n.pt`` is the nano model, tuned for edge CPU/GPU performance.
MODEL_PATH = os.getenv("ROAD_MODEL_PATH", str(PROJECT_ROOT / "yolov8n.pt"))

# ── YOLO inference knobs ──────────────────────────────────────────────────────
# Explicit per-call knobs threaded into ``model.track(...)`` / ``model(...)``
# in ``core/detection.py``. Previously the code relied on ultralytics' implicit
# defaults, which meant full-precision weights even on CUDA hardware that
# could run FP16 for free, and a hard-coded 640 px letterbox regardless of the
# deployed frame size. These knobs make both explicit.
#
# ``ROAD_YOLO_IMGSZ`` — square inference size in pixels. Ultralytics resizes
# the input frame to this on each call; 640 is its own default and a good
# general-purpose baseline. Lower to 512/448 on small edge boxes to trade a
# bit of recall for latency; raise to 960 on GPU when you need distant-object
# recall.
YOLO_IMGSZ = int(os.getenv("ROAD_YOLO_IMGSZ", "640"))

# ``ROAD_YOLO_HALF`` — FP16 inference toggle. Default is ``False`` because
# FP16 is only safe on CUDA (CPU + Apple MPS either ignore it or misbehave).
# We cannot auto-upgrade to ``True`` here because ``config.py`` must not
# import ``torch`` (it sits at the bottom of the dependency graph and runs
# at ``from backend.config import *`` time, before torch is guaranteed
# importable). ``core/detection.py`` owns the actual device detection and
# logs a hint when the selected device is CUDA but this flag is off.
YOLO_HALF = os.getenv("ROAD_YOLO_HALF", "0").lower() not in ("0", "false", "no", "")

# ``ROAD_YOLO_WARMUP`` — run a single synthetic inference at server start so
# the first real frame doesn't pay the JIT / MPS compile cost. Default on;
# set to 0/false/no in tests or when cold-start latency is irrelevant.
YOLO_WARMUP = os.getenv("ROAD_YOLO_WARMUP", "1").lower() not in ("0", "false", "no", "")

# ``yt-dlp`` is used by ``core/stream.py`` to resolve YouTube / HLS URLs. We
# prefer the binary bundled in the project's virtualenv (``.venv/bin/``) so a
# ``pip install`` pins the version; fall back to the system ``yt-dlp`` on
# PATH if the venv one is absent (e.g. Docker images that install globally).
_VENV_YT_DLP = PROJECT_ROOT / ".venv" / "bin" / "yt-dlp"
YT_DLP_PATH = str(_VENV_YT_DLP) if _VENV_YT_DLP.exists() else "yt-dlp"

# ``ROAD_YT_COOKIES_FROM_BROWSER`` — optional browser name (chrome, safari,
# firefox, edge, brave, chromium) yt-dlp pulls cookies from. YouTube may gate
# live streams behind a "Sign in to confirm you're not a bot" check that only
# clears with a cookie jar. Disabled by default because reading Chrome cookies
# on macOS triggers a keychain password prompt; set the env var explicitly
# when you need YouTube live streams to resolve.
YT_COOKIES_FROM_BROWSER = os.getenv("ROAD_YT_COOKIES_FROM_BROWSER", "").strip()

# ─────────────────────────────────────────────────────────────────────────────
# Section: STREAM SETTINGS
# ─────────────────────────────────────────────────────────────────────────────
# Local-file fallback: when no operator has configured streams via
# ``ROAD_STREAM_SOURCE`` or ``ROAD_STREAM_SOURCES``, we default to the
# bundled MP4 clips so the admin UI has something to show out of the box.
# The ``StreamReader`` loops local files, so the demo replays end-to-end
# without operator action. Set either env var to point at real fixed
# road-camera live streams (YouTube intersection cams, HLS URLs) for a
# production deployment.
_DEMO_FRONT_CAM_FILE = PROJECT_ROOT / "resourses" / "Front Cam.mp4"
_DEMO_REAR_CAM_FILE = PROJECT_ROOT / "resourses" / "Rear Cam.mp4"
_DEMO_LEFT_CAM_FILE = PROJECT_ROOT / "resourses" / "Left Cam.mp4"
_DEMO_DASHCAM_FILE = _DEMO_FRONT_CAM_FILE  # back-compat alias for legacy imports (name kept for API stability)
_DEMO_DASHCAM_SOURCE = str(_DEMO_DASHCAM_FILE) if _DEMO_DASHCAM_FILE.exists() else ""
_DEMO_REAR_CAM_SOURCE = str(_DEMO_REAR_CAM_FILE) if _DEMO_REAR_CAM_FILE.exists() else ""
_DEMO_LEFT_CAM_SOURCE = str(_DEMO_LEFT_CAM_FILE) if _DEMO_LEFT_CAM_FILE.exists() else ""

# ``ROAD_STREAM_SOURCE`` — what the edge node captures from. Empty string
# falls back to the local-file loop above. Accepted forms: HLS URL,
# local file path, webcam index (e.g. ``0``), YouTube URL (live traffic
# / intersection cams are the primary target).
DEFAULT_STREAM_SOURCE = os.getenv("ROAD_STREAM_SOURCE", _DEMO_DASHCAM_SOURCE)


def _parse_stream_sources() -> list[dict[str, str]]:
    """Parse ``ROAD_STREAM_SOURCES`` into a list of ``{id, name, url}`` dicts.

    Two accepted formats (auto-detected per entry, comma-separated):
      - bare URL: ``https://youtu.be/abc`` — id auto-assigned ``src1``,
        name derived from URL.
      - labelled: ``id|name|url`` (pipe-separated 3-tuple) — explicit ids
        let operators address streams stably from the API.

    When unset, falls back to a single-element list built from
    ``DEFAULT_STREAM_SOURCE`` (preserving the legacy single-stream
    behaviour). When both env vars are empty, returns ``[]`` and the server
    starts with no live sources — the operator can still add them via API.
    """
    raw = os.getenv("ROAD_STREAM_SOURCES", "").strip()
    if not raw:
        if DEFAULT_STREAM_SOURCE:
            # Demo naming: when the fallback is the bundled MP4 loop, label
            # each source with the camera-site identity used by the demo so
            # the admin UI shows something more informative than "Primary".
            # When additional site-angle MP4s are present, add them as
            # extra sources so multiple camera angles at the same road /
            # intersection site are monitored in parallel.
            if DEFAULT_STREAM_SOURCE == _DEMO_DASHCAM_SOURCE:
                sources = [{
                    "id": "primary",
                    "name": "Fox Factory — Nissan Rogue XX 001 X — Front Cam",
                    "url": DEFAULT_STREAM_SOURCE,
                }]
                if _DEMO_REAR_CAM_SOURCE:
                    sources.append({
                        "id": "rear",
                        "name": "Fox Factory — Nissan Rogue XX 001 X — Rear Cam",
                        "url": _DEMO_REAR_CAM_SOURCE,
                    })
                if _DEMO_LEFT_CAM_SOURCE:
                    sources.append({
                        "id": "left",
                        "name": "Fox Factory — Nissan Rogue XX 001 X — Left Cam",
                        "url": _DEMO_LEFT_CAM_SOURCE,
                    })
                return sources
            return [{"id": "primary", "name": "Primary", "url": DEFAULT_STREAM_SOURCE}]
        return []
    # Prefer ``;`` as the entry separator when it's present (lets labelled
    # entries carry commas in their display names, e.g. "Glenwood Springs,
    # CO"). Fall back to ``,`` for the simpler legacy format.
    sep = ";" if ";" in raw else ","
    out: list[dict[str, str]] = []
    for i, entry in enumerate(raw.split(sep)):
        entry = entry.strip()
        if not entry:
            continue
        if "|" in entry:
            parts = [p.strip() for p in entry.split("|", 2)]
            if len(parts) == 3 and parts[0] and parts[2]:
                out.append({"id": parts[0], "name": parts[1] or parts[0], "url": parts[2]})
                continue
        # Bare URL — auto id/name. First entry becomes "primary" so legacy
        # endpoints (``/admin/video_feed`` without a source id) continue to
        # serve the same stream as before.
        sid = "primary" if i == 0 else f"src{i + 1}"
        name = "Primary" if i == 0 else f"Source {i + 1}"
        out.append({"id": sid, "name": name, "url": entry})
    return out


# List of ``{id, name, url}`` dicts the edge node will monitor in parallel.
# Each source is a distinct road / intersection camera feed; every one
# gets its own perception slot (reader + quality/scene/episodes) and emits
# events tagged with ``source_id``. See ``server.py::StreamSlot``.
STREAM_SOURCES = _parse_stream_sources()

# ``ROAD_TARGET_FPS`` — processing rate of the perception loop. The default
# of 2 fps is the tested sweet spot: fast enough to catch TTC windows
# (time-to-collision) for vehicles / pedestrians moving through an
# intersection, slow enough to keep the CPU cool and leave headroom for
# LLM enrichment. Increasing this blindly burns budget.
TARGET_FPS = float(os.getenv("ROAD_TARGET_FPS", "2.0"))

# ─────────────────────────────────────────────────────────────────────────────
# Section: EVENT BUFFER
# ─────────────────────────────────────────────────────────────────────────────
# ``ROAD_MAX_EVENTS`` caps the in-memory ring buffer of recent events the
# admin UI queries. 500 ≈ ~30 min at typical detection rate; raise only if
# RAM allows and you know why.
MAX_RECENT_EVENTS = int(os.getenv("ROAD_MAX_EVENTS", "500"))
# When a new SSE client connects we replay this many recent events so the
# UI isn't empty until the next detection. Hard-coded (not env-configurable)
# because it's a UX constant, not a deployment knob.
SSE_REPLAY_COUNT = 20

# ─────────────────────────────────────────────────────────────────────────────
# Section: EPISODE / DEDUP MODEL
# ─────────────────────────────────────────────────────────────────────────────
# ``ROAD_PAIR_COOLDOWN_SEC`` — after emitting an event for a tracked
# pair of objects in the scene, suppress repeat events from the same pair
# for this many seconds. Prevents one sustained near-miss from spamming
# 20 events.
PAIR_COOLDOWN_SEC = float(os.getenv("ROAD_PAIR_COOLDOWN_SEC", "8.0"))
# If an episode has no new risk frames for this long, flush it. Hard-coded
# because it's tied to ``TARGET_FPS`` and the gate timings in ``core/``.
EPISODE_IDLE_FLUSH_SEC = 1.5

# ─────────────────────────────────────────────────────────────────────────────
# Section: PRIVACY / COMPLIANCE
# ─────────────────────────────────────────────────────────────────────────────
# Salt for hashing ALPR plate text before it enters any buffer. Generated
# per-process via ``secrets.token_hex(16)`` if not set — fine for
# single-host dev, **must be set explicitly in production** so hashes stay
# stable across restarts (otherwise repeat-offender analytics reset).
PLATE_SALT = os.getenv("ROAD_PLATE_SALT", secrets.token_hex(16))
# Audit-log toggle. Defaults to enabled ("1"); set ``ROAD_AUDIT_LOG=0`` to
# disable. Disabling is only acceptable in tests — compliance expects it on.
AUDIT_ENABLED = os.getenv("ROAD_AUDIT_LOG", "1") != "0"
# ALPR integration mode for external license-plate OCR services.
#   ``off``       — never call out (default, privacy-preserving).
#   ``on``        — always call.
#   ``on_demand`` — only when an event is flagged for review.
# Normalised to lowercase so config files can use any casing.
ALPR_MODE = os.getenv("ROAD_ALPR_MODE", "off").strip().lower()

# ─────────────────────────────────────────────────────────────────────────────
# Section: CAMERA-SITE IDENTITY
# ─────────────────────────────────────────────────────────────────────────────
# These three are conceptually **required** in production. The server boots
# anyway if they're missing (so dev on a laptop still works) but it logs a
# warning and tags events with ``unidentified_*_<hostname>`` — such events
# will never attribute to a real road / camera-site entity.
# Demo defaults match the identity baked into the bundled MP4 clips. The
# variable names ``VEHICLE_ID`` / ``ROAD_ID`` / ``DRIVER_ID`` are kept for
# API stability; conceptually they identify the camera install (the
# physical unit), the road / intersection it watches, and the operator
# responsible for it. Override via env vars for real deployments; the
# server also logs a warning when these remain at their hostname-derived
# fallback (see ``_MISSING_IDENTITY`` in server.py).
VEHICLE_ID = os.getenv("ROAD_VEHICLE_ID", "fox_factory_rogue_xx001x")
ROAD_ID = os.getenv("ROAD_ID", "fox_factory_demo_route")
DRIVER_ID = os.getenv("ROAD_DRIVER_ID", "fox_factory_driver_01")

# ─────────────────────────────────────────────────────────────────────────────
# Section: LOCATION
# ─────────────────────────────────────────────────────────────────────────────
# Free-form location tag attached to every event (e.g. "US-CA-SF" or a
# geohash). Used for dashboards; no validation here by design.
LOCATION = os.getenv("ROAD_LOCATION", "")

# ─────────────────────────────────────────────────────────────────────────────
# Section: CAMERA CALIBRATION (per-install / per-site)
# ─────────────────────────────────────────────────────────────────────────────
# Monocular depth and apparent-motion math depend on these. Defaults are
# for a coarse observation camera; production deployments calibrate per
# camera site. Override via env to match each camera's focal length (px)
# and mounting height (m) above the road. Getting these wrong biases
# every distance and speed signal downstream — treat them as deployment
# config, not constants.
#
# ``ROAD_CAMERA_FOCAL_PX``       — focal length in pixels. Used by the
#                                  pinhole model to convert bbox heights
#                                  into metres of depth.
# ``ROAD_CAMERA_HEIGHT_M``       — mounting height above ground in metres.
#                                  Sets the baseline for ground-plane
#                                  homography used by apparent-motion
#                                  estimates.
# ``ROAD_CAMERA_HORIZON_FRAC``   — vertical fraction of the frame where the
#                                  horizon sits (0 = top, 1 = bottom).
#                                  0.5 is the geometric centre; tilt the
#                                  camera down and you want a higher value.
# Defaults tuned for a coarse pole-mounted observation camera framing an
# intersection. The focal length and horizon defaults are rough — anyone
# deploying against a real fixed road camera should override them via env
# once the per-site calibration procedure in ``docs/`` has been run.
CAMERA_FOCAL_PX = float(os.getenv("ROAD_CAMERA_FOCAL_PX", "600.0"))
CAMERA_HEIGHT_M = float(os.getenv("ROAD_CAMERA_HEIGHT_M", "1.25"))
CAMERA_HORIZON_FRAC = float(os.getenv("ROAD_CAMERA_HORIZON_FRAC", "0.45"))


# ─────────────────────────────────────────────────────────────────────────────
# Section: PER-CAMERA CALIBRATION (multi-slot demo + multi-site deployments)
# ─────────────────────────────────────────────────────────────────────────────
# A single deployment commonly monitors multiple road cameras at once —
# different intersections, or multiple angles at one site. Each has its
# own focal length, mount height, tilt (horizon fraction), orientation
# relative to the road it watches, and an optional offset from the
# camera's optical centre to the edge of the scene it actually cares
# about. Reusing one global ``CAMERA_*`` constant for all of them biases
# every distance and TTC reading downstream by 20–50 % (focal mismatch
# alone) plus any additive geometry offset on top.
#
# This block defines:
#   * ``CameraCalibration`` — frozen dataclass bundling the five intrinsics.
#   * Hard-coded per-slot defaults that match the bundled demo loop.
#     Variable names refer to "front / rear / left / right" sibling angles
#     within a single camera-site install.
#   * ``camera_calibration_for(slot_id)`` — looks up the slot default and
#     applies any ``ROAD_CAMERA_<FIELD>__<SLOT>`` env overrides on top.
#
# Per-slot env override grammar (all optional, slot id upper-cased):
#   ROAD_CAMERA_FOCAL_PX__<SLOT>        → focal length in pixels at the
#                                          decoded frame width
#   ROAD_CAMERA_HEIGHT_M__<SLOT>        → camera mount height (m above ground)
#   ROAD_CAMERA_HORIZON_FRAC__<SLOT>    → vertical fraction of frame where
#                                          the horizon sits (0 = top, 1 = bot)
#   ROAD_CAMERA_ORIENTATION__<SLOT>     → "forward" | "rear" | "side"
#                                          - forward / rear = pinhole +
#                                            ground-plane prior both apply
#                                            (camera looks along the road).
#                                          - side = ground-plane prior is
#                                            invalid (no road below the
#                                            optical axis); known-height
#                                            prior only. Distance reading
#                                            represents *lateral* range
#                                            across the scene.
#   ROAD_CAMERA_BUMPER_OFFSET_M__<SLOT> → metres from the camera mount point
#                                          to the edge of the scene-of-
#                                          interest along its optical axis.
#                                          Subtracted from every distance
#                                          reading so the number reported
#                                          is the gap at the reference
#                                          plane, not to the camera glass.
#                                          (Name "bumper_offset" kept for
#                                          API stability with legacy code.)
#
# Why a frozen dataclass: calibration is immutable for the lifetime of a
# slot. Freezing it makes accidental mutation impossible and lets the
# value safely live on multiple threads (perception worker + validator).


@dataclass(frozen=True)
class CameraCalibration:
    """Per-camera intrinsics + mount geometry + scene-edge offset.

    Attributes:
        focal_px: Focal length of the lens expressed in pixels at the
            *decoded* frame width the perception loop actually sees.
            Wider lenses produce smaller numbers for the same sensor —
            a narrow road-cam lens at 640-wide decode sits near 600 px,
            an ultra-wide at the same decode sits near 260 px.
        height_m: Mount height above the road in metres. Drives the
            ground-plane distance prior and the apparent-motion math.
        horizon_frac: Vertical fraction of the image where the horizon
            sits (0 top, 1 bottom). 0.45 for a slightly down-tilted
            pole / mast camera looking along the road; 0.5 for a level
            side-mounted camera that frames traffic perpendicular to
            its optical axis.
        orientation: ``"forward"``, ``"rear"``, or ``"side"``.
            - ``forward`` / ``rear``: standard pinhole + ground-plane.
              Reported distance is the longitudinal range to the camera
              (and after offset, to the edge of the scene-of-interest).
            - ``side``: ground-plane prior is invalid (the road is not
              below the optical axis for a perpendicular-mounted cam);
              only the known-height prior is used. The reported distance
              is *lateral* — cross-scene range, not along-road range.
        bumper_offset_m: Distance from the camera mount point to the
            edge of the scene-of-interest along the optical axis, in
            metres. Subtracted from every estimate so the published
            value is the gap at the reference plane rather than the gap
            to the camera itself. (Field name kept as ``bumper_offset_m``
            for API / import stability.)
    """

    focal_px: float
    height_m: float
    horizon_frac: float
    orientation: str = "forward"
    bumper_offset_m: float = 0.0


# Default calibration — matches the legacy global ``CAMERA_*`` constants so
# any code path that does not yet thread a per-slot calibration through
# preserves its old behaviour to the byte.
DEFAULT_CAMERA_CALIBRATION = CameraCalibration(
    focal_px=CAMERA_FOCAL_PX,
    height_m=CAMERA_HEIGHT_M,
    horizon_frac=CAMERA_HORIZON_FRAC,
    orientation="forward",
    bumper_offset_m=0.0,
)


# Per-slot defaults for the bundled demo camera site. Real deployments
# override these per camera via the ``ROAD_CAMERA_*__<SLOT>`` env vars.
#
# Reference mount geometry baked into the bundled MP4 clips — a single
# road / intersection site with up to four camera angles. Numbers are a
# best-guess for a generic pole-mounted install and are documented here
# so the slot defaults below make sense at a glance:
#   * primary / forward-along-road angle → ground: 1.25 m, edge: 1.7 m
#   * rear / opposite-along-road angle   → ground: 1.10 m, edge: 0.3 m
#   * left lateral angle                 → ground: 1.00 m, edge: 0.1 m
#
# Lens focal length at the perception loop's 640-wide decode:
#   * narrow / standard lens    → ≈ 600 px (along-road angles)
#   * ultra-wide lens           → ≈ 260 px (lateral / cross-road angles)
_PER_SLOT_CAMERA_DEFAULTS: dict[str, CameraCalibration] = {
    # Primary along-road angle: standard / narrow lens looking down the
    # road the camera is installed on.
    "primary": CameraCalibration(
        focal_px=600.0, height_m=1.25, horizon_frac=0.45,
        orientation="forward", bumper_offset_m=1.7,
    ),
    "front": CameraCalibration(
        focal_px=600.0, height_m=1.25, horizon_frac=0.45,
        orientation="forward", bumper_offset_m=1.7,
    ),
    # Opposite along-road angle (ultra-wide). Same pinhole + ground-plane
    # math as the forward angle, just smaller focal + lower mount + a
    # smaller scene-edge offset.
    "rear": CameraCalibration(
        focal_px=260.0, height_m=1.10, horizon_frac=0.45,
        orientation="rear", bumper_offset_m=0.3,
    ),
    # Left cross-road angle: ultra-wide lens perpendicular to the road.
    # Horizon sits at image-center because the camera is level. Distance
    # reading is lateral across the scene, not along the road — see
    # ``CameraCalibration.orientation``.
    "left": CameraCalibration(
        focal_px=260.0, height_m=1.00, horizon_frac=0.50,
        orientation="side", bumper_offset_m=0.1,
    ),
    "left_side": CameraCalibration(
        focal_px=260.0, height_m=1.00, horizon_frac=0.50,
        orientation="side", bumper_offset_m=0.1,
    ),
    # Right cross-road angle: mirror of the left side. Provided for
    # symmetric multi-camera site installs even though the bundled demo
    # MP4s do not include one.
    "right": CameraCalibration(
        focal_px=260.0, height_m=1.00, horizon_frac=0.50,
        orientation="side", bumper_offset_m=0.1,
    ),
    "right_side": CameraCalibration(
        focal_px=260.0, height_m=1.00, horizon_frac=0.50,
        orientation="side", bumper_offset_m=0.1,
    ),
}


def _camera_env_float(slot_id: str, field_suffix: str, fallback: float) -> float:
    """Read ``ROAD_CAMERA_<FIELD>__<SLOT>`` as a float, with a fallback.

    Empty / missing / unparseable values silently fall back so a typo in
    one knob never crashes the perception loop.
    """
    raw = os.getenv(f"ROAD_CAMERA_{field_suffix}__{slot_id.upper()}", "").strip()
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError:
        return fallback


def _camera_env_str(slot_id: str, field_suffix: str, fallback: str) -> str:
    raw = os.getenv(f"ROAD_CAMERA_{field_suffix}__{slot_id.upper()}", "").strip().lower()
    if raw not in {"forward", "rear", "side"}:
        return fallback
    return raw


def camera_calibration_for(slot_id: str) -> CameraCalibration:
    """Resolve the effective per-camera calibration for a stream slot.

    Lookup order (later wins):
      1. ``DEFAULT_CAMERA_CALIBRATION`` (legacy single-camera defaults).
      2. ``_PER_SLOT_CAMERA_DEFAULTS[slot_id]`` if a slot-specific entry
         exists (covers the bundled demo site's camera angles).
      3. ``ROAD_CAMERA_<FIELD>__<SLOT>`` env overrides per field.

    Args:
        slot_id: The stream slot identifier (e.g. ``"primary"``,
            ``"rear"``, ``"left"``, or any operator-defined id).

    Returns:
        A frozen ``CameraCalibration`` ready to thread through the
        distance / TTC pipeline.
    """
    base = _PER_SLOT_CAMERA_DEFAULTS.get(slot_id, DEFAULT_CAMERA_CALIBRATION)
    return replace(
        base,
        focal_px=_camera_env_float(slot_id, "FOCAL_PX", base.focal_px),
        height_m=_camera_env_float(slot_id, "HEIGHT_M", base.height_m),
        horizon_frac=_camera_env_float(slot_id, "HORIZON_FRAC", base.horizon_frac),
        orientation=_camera_env_str(slot_id, "ORIENTATION", base.orientation),
        bumper_offset_m=_camera_env_float(slot_id, "BUMPER_OFFSET_M", base.bumper_offset_m),
    )

# ─────────────────────────────────────────────────────────────────────────────
# Section: DISTANCE / DEPTH ESTIMATION
# ─────────────────────────────────────────────────────────────────────────────
# Controls which depth estimator feeds ``estimate_distance_m``.
#   off      — disable distance estimation entirely (skip the compute).
#   pinhole  — default; pinhole + ground-plane geometry only, no GPU.
#   neural   — use the neural model (see ``core/depth_neural.py``); falls
#              back to pinhole when the neural load fails.
#   fused    — run both and keep the more conservative (larger) estimate.
# ``ROAD_DEPTH_BACKEND`` picks the neural weights (midas_small default).
DEPTH_MODEL = os.getenv("ROAD_DEPTH_MODEL", "pinhole").strip().lower()

# ─────────────────────────────────────────────────────────────────────────────
# Section: SERVER
# ─────────────────────────────────────────────────────────────────────────────
# ``ROAD_HOST`` — interface to bind. ``0.0.0.0`` = all IPv4, ``127.0.0.1`` =
# loopback only (safer for dev). Default here differs from ``start.py``
# which binds loopback; when running via docker/systemd we bind 0.0.0.0.
SERVER_HOST = os.getenv("ROAD_HOST", "0.0.0.0")
# ``ROAD_PORT`` — HTTP port for the edge server. 8000 keeps the cloud
# receiver (8001) free on the same host for dev.
SERVER_PORT = int(os.getenv("ROAD_PORT", "8000"))
# How often the per-road / operator safety-score decay job runs, in
# seconds. Hourly (3600) by default. Set to 0 to disable decay entirely
# (scores persist).
SCORE_DECAY_INTERVAL_SEC = int(os.getenv("ROAD_SCORE_DECAY_INTERVAL_SEC", "3600"))

# ─────────────────────────────────────────────────────────────────────────────
# Section: WATCHDOG
# ─────────────────────────────────────────────────────────────────────────────
# The incident-queue watchdog (``services/watchdog.py``) groups repeated
# errors with fingerprints + impact + likely cause. Disable in tests or when
# debugging raw stack traces.
# ``ROAD_WATCHDOG_ENABLED`` accepts multiple falsey spellings ("0"/"false"/
# "no", case-insensitive) so operators can set it intuitively.
WATCHDOG_ENABLED = os.getenv("ROAD_WATCHDOG_ENABLED", "1").lower() not in ("0", "false", "no")
# Seconds between watchdog sweeps. 60s is the default: fast enough to page
# on real incidents, slow enough to avoid amplifying noise during a storm.
WATCHDOG_INTERVAL_SEC = int(os.getenv("ROAD_WATCHDOG_INTERVAL_SEC", "60"))

# ─────────────────────────────────────────────────────────────────────────────
# Section: BACKGROUND VALIDATOR (dual-model shadow detection)
# ─────────────────────────────────────────────────────────────────────────────
# A second, heavier detector that shadows the primary YOLO pipeline. It
# never gates live alerts — it runs off a bounded queue, re-processes the
# peak frame of every emitted episode, and samples "quiet" frames to look
# for events the primary missed. Disagreements become watchdog incidents
# under the ``validator`` category.
#
# Enabled by default — the demo wants dual-model disagreement surfaced in
# the watchdog out of the box. Operators who need to reclaim the CPU/GPU
# budget can still disable it with ``ROAD_VALIDATOR_ENABLED=0`` or pause
# it at runtime via ``POST /api/validator/toggle`` from the Monitoring UI.
VALIDATOR_ENABLED = os.getenv("ROAD_VALIDATOR_ENABLED", "1").lower() not in ("0", "false", "no", "")
# Which backend to use. ``rtdetr`` uses ultralytics' RT-DETR-L weights —
# same package as YOLO, no new dependency. ``codetr``/``rfdetr`` would
# need optional extra deps and are not implemented yet.
VALIDATOR_BACKEND = os.getenv("ROAD_VALIDATOR_BACKEND", "rtdetr").strip().lower()
VALIDATOR_MODEL_PATH = os.getenv("ROAD_VALIDATOR_MODEL_PATH", "rtdetr-l.pt")
# Explicit device pin for the secondary. Empty = auto. Operators typically
# pin this to ``cpu`` when the primary is on the GPU so the two don't
# contend for memory or compute.
VALIDATOR_DEVICE = os.getenv("ROAD_VALIDATOR_DEVICE", "")
# Minimum seconds between sampled (non-episode) validator jobs per source.
# 3s ≈ one shadow pass every 6 primary frames at TARGET_FPS=2.
VALIDATOR_SAMPLE_SEC = float(os.getenv("ROAD_VALIDATOR_SAMPLE_SEC", "3.0"))
# Bounded queue depth — if the worker can't keep up, oldest jobs are dropped.
VALIDATOR_QUEUE_MAX = int(os.getenv("ROAD_VALIDATOR_QUEUE_MAX", "32"))
# IoU threshold for "same object" matching between primary and secondary
# bboxes. ≥0.3 is a lenient match so noisy secondary detections still count.
VALIDATOR_IOU_THRESHOLD = float(os.getenv("ROAD_VALIDATOR_IOU_THRESHOLD", "0.3"))

# ─────────────────────────────────────────────────────────────────────────────
# Section: PER-SOURCE METADATA (BE-D1 Option B)
# ─────────────────────────────────────────────────────────────────────────────
# When ``True``, event emission and the live/admin APIs resolve perception
# metadata (quality / scene / ego) from the slot that *produced* the event
# instead of always reading the primary slot's proxies. This is the correct
# multi-source behaviour — otherwise a rear-camera event can be annotated
# with the front camera's perception state.
#
# The audit (BE-D1) calls for default-off for release N to preserve the
# exact legacy behaviour while FE migrates. We default it **on** here
# because this tree is a showcase build meant to demonstrate the
# release N+1 behaviour. Operators who need to pin the old semantics
# can set ``ROAD_PER_SOURCE_METADATA=0``.
PER_SOURCE_METADATA = os.getenv("ROAD_PER_SOURCE_METADATA", "1").lower() not in ("0", "false", "no", "")
