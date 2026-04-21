"""config.py — one place for every setting, path, and environment knob.

What it does:
    Reads environment variables (from the shell and from a `.env` file
    next to the project root) and exposes them as plain Python constants
    that the rest of the backend imports. Also builds the canonical
    folder paths (`data/`, `data/thumbnails/`, `frontend/dist/`, ...) so
    no module has to figure out "where am I on disk?" on its own.

Purpose:
    Single source of truth for configuration. Want to change the camera
    focal length, the YOLO model path, the admin API token, or the event
    buffer size? Do it here (or via env) and every module sees the new
    value. Prevents drift between modules using different defaults.

How it works:
    `os.getenv("NAME", "default")` reads env var NAME and falls back to
    `"default"` if unset. `load_dotenv(...)` from the `python-dotenv`
    library pre-loads a `.env` file into the process environment before
    those lookups run, so local development works without exporting
    shell vars. `Path(__file__).resolve().parent.parent` walks up from
    this file to the repo root. Groupings include: directory layout,
    YOLO model path, yt-dlp binary, stream FPS, episode cooldowns,
    privacy tokens (`DSAR_TOKEN`, `ADMIN_TOKEN`, `PLATE_SALT`,
    `AUDIT_ENABLED` for GDPR compliance), fleet identity
    (`VEHICLE_ID`, `ROAD_ID`, `DRIVER_ID`), per-camera calibration
    (focal length in pixels, mounting height in metres — wrong values
    poison every downstream distance/speed reading), server host/port,
    and watchdog interval.

Connects to:
    - Backend: imported by every backend module that needs a path or
      setting — `server.py`, `core/detection.py`, `core/stream.py`,
      `core/egomotion.py`, `services/*`, `compliance/*`.
    - UI: none directly — backend-only, but the values here shape what
      the frontend sees (e.g. `STATIC_DIR` is where FastAPI serves the
      built React bundle from).
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

# ── Project root is the parent of the road_safety/ package directory ──
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

# ── Directory layout ──
DATA_DIR = PROJECT_ROOT / "data"
THUMBS_DIR = DATA_DIR / "thumbnails"
STATIC_DIR = PROJECT_ROOT / "frontend" / "dist"
CORPUS_DIR = DATA_DIR / "corpus"

# ── YOLO model ──
MODEL_PATH = os.getenv("ROAD_MODEL_PATH", str(PROJECT_ROOT / "yolov8n.pt"))

# ── yt-dlp binary (inside venv or system) ──
_VENV_YT_DLP = PROJECT_ROOT / ".venv" / "bin" / "yt-dlp"
YT_DLP_PATH = str(_VENV_YT_DLP) if _VENV_YT_DLP.exists() else "yt-dlp"

# ── Stream settings ──
DEFAULT_STREAM_SOURCE = os.getenv("ROAD_STREAM_SOURCE", "")
TARGET_FPS = float(os.getenv("ROAD_TARGET_FPS", "2.0"))

# ── Event buffer ──
MAX_RECENT_EVENTS = int(os.getenv("ROAD_MAX_EVENTS", "500"))
SSE_REPLAY_COUNT = 20

# ── Episode model ──
PAIR_COOLDOWN_SEC = float(os.getenv("ROAD_PAIR_COOLDOWN_SEC", "8.0"))
EPISODE_IDLE_FLUSH_SEC = 1.5

# ── Privacy / compliance ──
DSAR_TOKEN = os.getenv("ROAD_DSAR_TOKEN")
ADMIN_TOKEN = os.getenv("ROAD_ADMIN_TOKEN")
PLATE_SALT = os.getenv("ROAD_PLATE_SALT", secrets.token_hex(16))
AUDIT_ENABLED = os.getenv("ROAD_AUDIT_LOG", "1") != "0"
PUBLIC_THUMBS_REQUIRE_TOKEN = os.getenv("ROAD_PUBLIC_THUMBS_REQUIRE_TOKEN", "0") == "1"
THUMB_SIGNING_SECRET = os.getenv(
    "ROAD_THUMB_SIGNING_SECRET",
    os.getenv("ROAD_CLOUD_HMAC_SECRET", ""),
)
ALPR_MODE = os.getenv("ROAD_ALPR_MODE", "off").strip().lower()

# ── Vehicle identity (all required via env in production) ──
VEHICLE_ID = os.getenv("ROAD_VEHICLE_ID", "")
ROAD_ID = os.getenv("ROAD_ID", "")
DRIVER_ID = os.getenv("ROAD_DRIVER_ID", "")

# ── Location ──
LOCATION = os.getenv("ROAD_LOCATION", "")

# ── Camera calibration (per-vehicle, per-install) ──
# Monocular depth and ego-speed math depend on these. Defaults are for a
# coarse observation camera; production deployments calibrate per-camera.
# Override via env to match each camera's focal length (px) and mounting
# height (m). Getting these wrong biases every distance and speed signal
# downstream — treat them as deployment config, not constants.
CAMERA_FOCAL_PX = float(os.getenv("ROAD_CAMERA_FOCAL_PX", "600.0"))
CAMERA_HEIGHT_M = float(os.getenv("ROAD_CAMERA_HEIGHT_M", "5.0"))
CAMERA_HORIZON_FRAC = float(os.getenv("ROAD_CAMERA_HORIZON_FRAC", "0.5"))

# ── Server ──
SERVER_HOST = os.getenv("ROAD_HOST", "0.0.0.0")
SERVER_PORT = int(os.getenv("ROAD_PORT", "8000"))
SCORE_DECAY_INTERVAL_SEC = int(os.getenv("ROAD_SCORE_DECAY_INTERVAL_SEC", "3600"))

# ── Watchdog ──
WATCHDOG_ENABLED = os.getenv("ROAD_WATCHDOG_ENABLED", "1").lower() not in ("0", "false", "no")
WATCHDOG_INTERVAL_SEC = int(os.getenv("ROAD_WATCHDOG_INTERVAL_SEC", "60"))
