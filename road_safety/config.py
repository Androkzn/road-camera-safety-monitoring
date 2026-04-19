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

# ``yt-dlp`` is used by ``core/stream.py`` to resolve YouTube / HLS URLs. We
# prefer the binary bundled in the project's virtualenv (``.venv/bin/``) so a
# ``pip install`` pins the version; fall back to the system ``yt-dlp`` on
# PATH if the venv one is absent (e.g. Docker images that install globally).
_VENV_YT_DLP = PROJECT_ROOT / ".venv" / "bin" / "yt-dlp"
YT_DLP_PATH = str(_VENV_YT_DLP) if _VENV_YT_DLP.exists() else "yt-dlp"

# ─────────────────────────────────────────────────────────────────────────────
# Section: STREAM SETTINGS
# ─────────────────────────────────────────────────────────────────────────────
# Demo "fake dashcam" fallback: when no operator has configured streams via
# ``ROAD_STREAM_SOURCE`` or ``ROAD_STREAM_SOURCES``, we default to the
# bundled MP4s so the admin UI has something to show out of the box. Two
# files ship with the repo:
#   * iPhone-captured front dashcam → tagged as the primary vehicle cam
#   * DJI drone/action-cam exterior view → tagged as "Left Side" so the
#     operator sees both angles of the same vehicle simultaneously.
# The ``StreamReader`` loops local files, so the demo replays end-to-end
# without operator action. Set either env var to override for a real
# deployment.
_DEMO_DASHCAM_FILE = PROJECT_ROOT / "resourses" / "Safe Fleet iPhone.mp4"
_DEMO_DJI_FILE = PROJECT_ROOT / "resourses" / "Safe Fleet DJI.mp4"
_DEMO_DASHCAM_SOURCE = str(_DEMO_DASHCAM_FILE) if _DEMO_DASHCAM_FILE.exists() else ""
_DEMO_DJI_SOURCE = str(_DEMO_DJI_FILE) if _DEMO_DJI_FILE.exists() else ""

# ``ROAD_STREAM_SOURCE`` — what the edge node captures from. Empty string
# falls back to the demo dashcam loop above. Accepted forms: HLS URL,
# local file path, webcam index (e.g. ``0``), YouTube URL.
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
            # Demo naming: when the fallback is the bundled dashcam MP4,
            # label it with the demo vehicle identity so the admin UI shows
            # "Fox Factory — Nissan Rogue XX 001 X" instead of "Primary".
            # When the DJI exterior-view MP4 is also present, add it as a
            # second source labelled "Left Side" so both angles of the demo
            # vehicle are monitored in parallel.
            if DEFAULT_STREAM_SOURCE == _DEMO_DASHCAM_SOURCE:
                sources = [{
                    "id": "primary",
                    "name": "Fox Factory — Nissan Rogue XX 001 X",
                    "url": DEFAULT_STREAM_SOURCE,
                }]
                if _DEMO_DJI_SOURCE:
                    sources.append({
                        "id": "left_side",
                        "name": "Left Side Camera",
                        "url": _DEMO_DJI_SOURCE,
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
# Each gets its own perception slot (reader + quality/scene/episodes) and
# emits events tagged with ``source_id``. See ``server.py::StreamSlot``.
STREAM_SOURCES = _parse_stream_sources()

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
# Demo defaults match the bundled dashcam MP4 vehicle identity (Nissan
# Rogue, plate XX 001 X, Fox Factory fleet). Override via env vars for
# real deployments; the server also logs a warning when these remain at
# their hostname-derived fallback (see ``_MISSING_IDENTITY`` in server.py).
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

# ─────────────────────────────────────────────────────────────────────────────
# Section: BACKGROUND VALIDATOR (dual-model shadow detection)
# ─────────────────────────────────────────────────────────────────────────────
# A second, heavier detector that shadows the primary YOLO pipeline. It
# never gates live alerts — it runs off a bounded queue, re-processes the
# peak frame of every emitted episode, and samples "quiet" frames to look
# for events the primary missed. Disagreements become watchdog incidents
# under the ``validator`` category.
#
# Disabled by default so production installations don't pay for it until
# the operator explicitly enables shadow-mode validation.
VALIDATOR_ENABLED = os.getenv("ROAD_VALIDATOR_ENABLED", "0").lower() not in ("0", "false", "no", "")
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
