"""Tests for road_safety.config — paths, env defaults, and constants."""

from pathlib import Path

from road_safety import __version__
from road_safety.config import (
    DATA_DIR,
    DEFAULT_STREAM_SOURCE,
    DRIVER_ID,
    EPISODE_IDLE_FLUSH_SEC,
    ROAD_ID,
    MAX_RECENT_EVENTS,
    MODEL_PATH,
    PAIR_COOLDOWN_SEC,
    PROJECT_ROOT,
    SERVER_HOST,
    SERVER_PORT,
    SSE_REPLAY_COUNT,
    STATIC_DIR,
    TARGET_FPS,
    THUMBS_DIR,
    VEHICLE_ID,
)


class TestProjectPaths:
    def test_project_root_exists(self):
        assert PROJECT_ROOT.exists()
        assert PROJECT_ROOT.is_dir()

    def test_project_root_contains_pyproject(self):
        assert (PROJECT_ROOT / "pyproject.toml").exists()

    def test_static_dir_exists(self):
        assert STATIC_DIR.exists()
        assert (STATIC_DIR / "index.html").exists()
        assert (STATIC_DIR / "admin.html").exists()

    def test_model_path_is_string(self):
        assert isinstance(MODEL_PATH, str)
        assert MODEL_PATH.endswith("yolov8n.pt")


class TestDefaults:
    def test_target_fps_default(self):
        assert TARGET_FPS > 0

    def test_max_recent_events(self):
        assert MAX_RECENT_EVENTS > 0

    def test_sse_replay_count(self):
        assert SSE_REPLAY_COUNT > 0

    def test_pair_cooldown(self):
        assert PAIR_COOLDOWN_SEC > 0

    def test_episode_idle_flush(self):
        assert EPISODE_IDLE_FLUSH_SEC > 0

    def test_server_host_default(self):
        assert SERVER_HOST == "127.0.0.1"

    def test_server_port_default(self):
        assert SERVER_PORT == 8000

    def test_vehicle_id_default(self):
        assert isinstance(VEHICLE_ID, str)
        assert len(VEHICLE_ID) > 0

    def test_road_id_default(self):
        assert isinstance(ROAD_ID, str)

    def test_driver_id_default(self):
        assert isinstance(DRIVER_ID, str)

    def test_stream_source_default(self):
        assert "youtube.com" in DEFAULT_STREAM_SOURCE or len(DEFAULT_STREAM_SOURCE) > 0


class TestPackageVersion:
    def test_version_string(self):
        assert isinstance(__version__, str)
        parts = __version__.split(".")
        assert len(parts) == 3
