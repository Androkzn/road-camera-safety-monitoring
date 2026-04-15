"""Tests for road_safety.config — paths, env defaults, and constants."""

from pathlib import Path

from road_safety import __version__
from road_safety.config import (
    ALPR_MODE,
    DATA_DIR,
    DEFAULT_STREAM_SOURCE,
    DRIVER_ID,
    EPISODE_IDLE_FLUSH_SEC,
    ROAD_ID,
    MAX_RECENT_EVENTS,
    MODEL_PATH,
    PAIR_COOLDOWN_SEC,
    PLATE_SALT,
    PUBLIC_THUMBS_REQUIRE_TOKEN,
    PROJECT_ROOT,
    SCORE_DECAY_INTERVAL_SEC,
    SERVER_HOST,
    SERVER_PORT,
    SSE_REPLAY_COUNT,
    STATIC_DIR,
    TARGET_FPS,
    THUMB_SIGNING_SECRET,
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

    def test_model_path_is_string(self):
        assert isinstance(MODEL_PATH, str)
        assert MODEL_PATH.endswith(".pt")


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

    def test_server_host_is_string(self):
        assert isinstance(SERVER_HOST, str)
        assert len(SERVER_HOST) > 0

    def test_server_port_default(self):
        assert SERVER_PORT == 8000

    def test_vehicle_id_is_string(self):
        assert isinstance(VEHICLE_ID, str)

    def test_road_id_is_string(self):
        assert isinstance(ROAD_ID, str)

    def test_driver_id_is_string(self):
        assert isinstance(DRIVER_ID, str)

    def test_stream_source_is_string(self):
        assert isinstance(DEFAULT_STREAM_SOURCE, str)

    def test_plate_salt_is_nonempty(self):
        assert isinstance(PLATE_SALT, str)
        assert len(PLATE_SALT) > 0

    def test_public_thumbs_guard_is_bool(self):
        assert isinstance(PUBLIC_THUMBS_REQUIRE_TOKEN, bool)

    def test_thumb_signing_secret_is_string(self):
        assert isinstance(THUMB_SIGNING_SECRET, str)

    def test_alpr_mode_is_string(self):
        assert isinstance(ALPR_MODE, str)

    def test_score_decay_interval_non_negative(self):
        assert SCORE_DECAY_INTERVAL_SEC >= 0


class TestPackageVersion:
    def test_version_string(self):
        assert isinstance(__version__, str)
        parts = __version__.split(".")
        assert len(parts) == 3
