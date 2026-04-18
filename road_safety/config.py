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
    constants so callers can ``from road_safety.config import TARGET_FPS``
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
"""

from __future__ import annotations

# Stdlib imports only plus ``python-dotenv`` for the ``.env`` loader. No
# project imports — this module sits at the bottom of the dependency graph.
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

# ─────────────────────────────────────────────────────────────────────────────
# Section: PROJECT ROOT AND DIRECTORY LAYOUT
# ─────────────────────────────────────────────────────────────────────────────
# Project root is the parent of the ``road_safety/`` package directory.
# ``Path(__file__)``        → absolute path to this config.py
# ``.resolve()``            → canonicalise (follow symlinks, make absolute)
# ``.parent``               → the ``road_safety/`` directory
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

# Frontend serving strategy:
#   If the built React bundle (``frontend/dist/``) exists, serve that. The
#   launcher (``start.py``) builds it before starting uvicorn. If it's
#   missing (e.g. fresh checkout, frontend skipped), fall back to the
#   hand-written ``static/`` placeholder so the API still boots.
_REACT_DIST = PROJECT_ROOT / "frontend" / "dist"
STATIC_DIR = _REACT_DIST if _REACT_DIST.exists() else PROJECT_ROOT / "static"

CORPUS_DIR = DATA_DIR / "corpus"

# ─────────────────────────────────────────────────────────────────────────────
# Section: PERCEPTION BINARIES (YOLO, yt-dlp)
# ─────────────────────────────────────────────────────────────────────────────
# Path to the YOLOv8 weights file. Override ``ROAD_MODEL_PATH`` when swapping
# to a custom-trained detector or a larger variant (yolov8s/m/l). Default
# ``yolov8n.pt`` is the nano model, tuned for edge CPU/GPU performance.
MODEL_PATH = os.getenv("ROAD_MODEL_PATH", str(PROJECT_ROOT / "yolov8n.pt"))

# ``yt-dlp`` is used by ``core/stream.py`` to resolve YouTube / HLS URLs. We
# prefer the binary bundled in the project's virtualenv (``.venv/bin/``) so a
# ``pip install`` pins the version; fall back to the system ``yt-dlp`` on
# PATH if the venv one is absent (e.g. Docker images that install globally).
_VENV_YT_DLP = PROJECT_ROOT / ".venv" / "bin" / "yt-dlp"
YT_DLP_PATH = str(_VENV_YT_DLP) if _VENV_YT_DLP.exists() else "yt-dlp"

# ─────────────────────────────────────────────────────────────────────────────
# Section: STREAM SETTINGS
# ─────────────────────────────────────────────────────────────────────────────
# ``ROAD_STREAM_SOURCE`` — what the edge node captures from. Empty string
# means "no default; set at runtime via API or docker-compose". Accepted
# forms: HLS URL, local file path, webcam index (e.g. ``0``), YouTube URL.
DEFAULT_STREAM_SOURCE = os.getenv("ROAD_STREAM_SOURCE", "")

# ``ROAD_TARGET_FPS`` — processing rate of the perception loop. The default
# of 2 fps is the tested sweet spot: fast enough to catch TTC windows
# (time-to-collision) in city driving, slow enough to keep the CPU cool and
# leave headroom for LLM enrichment. Increasing this blindly burns budget.
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
# (ego, other) pair, suppress repeat events from the same pair for this
# many seconds. Prevents one sustained near-miss from spamming 20 events.
PAIR_COOLDOWN_SEC = float(os.getenv("ROAD_PAIR_COOLDOWN_SEC", "8.0"))
# If an episode has no new risk frames for this long, flush it. Hard-coded
# because it's tied to ``TARGET_FPS`` and the gate timings in ``core/``.
EPISODE_IDLE_FLUSH_SEC = 1.5

# ─────────────────────────────────────────────────────────────────────────────
# Section: PRIVACY / COMPLIANCE
# ─────────────────────────────────────────────────────────────────────────────
# Data-Subject-Access-Request token. Required to download *unredacted*
# thumbnails through ``/api/thumb?internal=1``. Unset → those routes 503.
DSAR_TOKEN = os.getenv("ROAD_DSAR_TOKEN")
# Admin bearer token for operational endpoints (``/api/audit``,
# ``/api/llm/*``, ``/api/retention/*``, ...). Unset → those routes 503.
# See ``road_safety/security.py`` for the enforcement helper.
ADMIN_TOKEN = os.getenv("ROAD_ADMIN_TOKEN")
# Salt for hashing ALPR plate text before it enters any buffer. Generated
# per-process via ``secrets.token_hex(16)`` if not set — fine for
# single-host dev, **must be set explicitly in production** so hashes stay
# stable across restarts (otherwise repeat-offender analytics reset).
PLATE_SALT = os.getenv("ROAD_PLATE_SALT", secrets.token_hex(16))
# Audit-log toggle. Defaults to enabled ("1"); set ``ROAD_AUDIT_LOG=0`` to
# disable. Disabling is only acceptable in tests — compliance expects it on.
AUDIT_ENABLED = os.getenv("ROAD_AUDIT_LOG", "1") != "0"
# If "1", even the redacted public thumbnails require a token. Extra
# defence in depth for extra-sensitive deployments (hospitals, schools).
PUBLIC_THUMBS_REQUIRE_TOKEN = os.getenv("ROAD_PUBLIC_THUMBS_REQUIRE_TOKEN", "0") == "1"
# HMAC key used to sign thumbnail URLs (query-string integrity). Falls back
# to ``ROAD_CLOUD_HMAC_SECRET`` to let simple deployments share one secret.
THUMB_SIGNING_SECRET = os.getenv(
    "ROAD_THUMB_SIGNING_SECRET",
    os.getenv("ROAD_CLOUD_HMAC_SECRET", ""),
)
# ALPR integration mode for external license-plate OCR services.
#   ``off``       — never call out (default, privacy-preserving).
#   ``on``        — always call.
#   ``on_demand`` — only when an event is flagged for review.
# Normalised to lowercase so config files can use any casing.
ALPR_MODE = os.getenv("ROAD_ALPR_MODE", "off").strip().lower()

# ─────────────────────────────────────────────────────────────────────────────
# Section: FLEET / VEHICLE IDENTITY
# ─────────────────────────────────────────────────────────────────────────────
# These three are conceptually **required** in production. The server boots
# anyway if they're missing (so dev on a laptop still works) but it logs a
# warning and tags events with ``unidentified_*_<hostname>`` — such events
# will never attribute to a real fleet entity.
VEHICLE_ID = os.getenv("ROAD_VEHICLE_ID", "")
ROAD_ID = os.getenv("ROAD_ID", "")
DRIVER_ID = os.getenv("ROAD_DRIVER_ID", "")

# ─────────────────────────────────────────────────────────────────────────────
# Section: LOCATION
# ─────────────────────────────────────────────────────────────────────────────
# Free-form location tag attached to every event (e.g. "US-CA-SF" or a
# geohash). Used for dashboards; no validation here by design.
LOCATION = os.getenv("ROAD_LOCATION", "")

# ─────────────────────────────────────────────────────────────────────────────
# Section: CAMERA CALIBRATION (per-vehicle, per-install)
# ─────────────────────────────────────────────────────────────────────────────
# Monocular depth and ego-speed math depend on these. Defaults are for a
# coarse observation camera; production deployments calibrate per-camera.
# Override via env to match each camera's focal length (px) and mounting
# height (m). Getting these wrong biases every distance and speed signal
# downstream — treat them as deployment config, not constants.
#
# ``ROAD_CAMERA_FOCAL_PX``       — focal length in pixels. Used by the
#                                  pinhole model to convert bbox heights
#                                  into metres of depth.
# ``ROAD_CAMERA_HEIGHT_M``       — mounting height above ground in metres.
#                                  Sets the baseline for ground-plane
#                                  homography used by ego-speed estimates.
# ``ROAD_CAMERA_HORIZON_FRAC``   — vertical fraction of the frame where the
#                                  horizon sits (0 = top, 1 = bottom).
#                                  0.5 is the geometric centre; tilt the
#                                  camera down and you want a higher value.
CAMERA_FOCAL_PX = float(os.getenv("ROAD_CAMERA_FOCAL_PX", "600.0"))
CAMERA_HEIGHT_M = float(os.getenv("ROAD_CAMERA_HEIGHT_M", "5.0"))
CAMERA_HORIZON_FRAC = float(os.getenv("ROAD_CAMERA_HORIZON_FRAC", "0.5"))

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
# How often the driver-safety-score decay job runs, in seconds. Hourly
# (3600) by default. Set to 0 to disable decay entirely (scores persist).
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
