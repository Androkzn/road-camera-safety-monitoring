"""Tests for backend.config — paths, env defaults, and constants."""

from pathlib import Path

from backend import __version__
from backend.config import (
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
    PROJECT_ROOT,
    SCORE_DECAY_INTERVAL_SEC,
    SERVER_HOST,
    SERVER_PORT,
    SSE_REPLAY_COUNT,
    STATIC_DIR,
    TARGET_FPS,
    THUMBS_DIR,
    VEHICLE_ID,
)


class TestProjectPaths:
    """Sanity checks on the hard-coded paths exported from ``backend.config``."""

    def test_project_root_exists(self):
        """PROJECT_ROOT points to a real directory."""
        assert PROJECT_ROOT.exists()
        assert PROJECT_ROOT.is_dir()

    def test_project_root_contains_pyproject(self):
        """PROJECT_ROOT is the true project root (has pyproject.toml)."""
        assert (PROJECT_ROOT / "pyproject.toml").exists()

    def test_static_dir_exists(self):
        """STATIC_DIR is the built frontend; must contain index.html to serve."""
        assert STATIC_DIR.exists()
        assert (STATIC_DIR / "index.html").exists()

    def test_model_path_is_string(self):
        """MODEL_PATH resolves to a .pt weights file (YOLO format)."""
        assert isinstance(MODEL_PATH, str)
        assert MODEL_PATH.endswith(".pt")


class TestDefaults:
    """Every env-driven default exports as the documented Python type."""

    def test_target_fps_default(self):
        """TARGET_FPS is a positive sampling rate."""
        assert TARGET_FPS > 0

    def test_max_recent_events(self):
        """MAX_RECENT_EVENTS is the SSE buffer cap; must be > 0."""
        assert MAX_RECENT_EVENTS > 0

    def test_sse_replay_count(self):
        """SSE_REPLAY_COUNT (events replayed to a new subscriber) is > 0."""
        assert SSE_REPLAY_COUNT > 0

    def test_pair_cooldown(self):
        """PAIR_COOLDOWN_SEC (debounce between repeat alerts) is > 0."""
        assert PAIR_COOLDOWN_SEC > 0

    def test_episode_idle_flush(self):
        """Episode idle-flush timeout is positive."""
        assert EPISODE_IDLE_FLUSH_SEC > 0

    def test_server_host_is_string(self):
        """SERVER_HOST is a non-empty string (hostname/IP)."""
        assert isinstance(SERVER_HOST, str)
        assert len(SERVER_HOST) > 0

    def test_server_port_default(self):
        """Default SERVER_PORT is 8000 (matches docs/docker-compose)."""
        assert SERVER_PORT == 8000

    def test_vehicle_id_is_string(self):
        """Fleet identity vehicle_id renders as a string."""
        assert isinstance(VEHICLE_ID, str)

    def test_road_id_is_string(self):
        """road_id renders as a string."""
        assert isinstance(ROAD_ID, str)

    def test_driver_id_is_string(self):
        """driver_id renders as a string."""
        assert isinstance(DRIVER_ID, str)

    def test_stream_source_is_string(self):
        """Default stream source is a string (URL, file path, or webcam index)."""
        assert isinstance(DEFAULT_STREAM_SOURCE, str)

    def test_plate_salt_is_nonempty(self):
        """Plate-hash salt must be present so ``hash_plate`` can't be rainbow-tabled."""
        assert isinstance(PLATE_SALT, str)
        assert len(PLATE_SALT) > 0

    def test_alpr_mode_is_string(self):
        """ALPR_MODE controls license-plate recognition mode ("off"/"on"/...)."""
        assert isinstance(ALPR_MODE, str)

    def test_score_decay_interval_non_negative(self):
        """Decay interval may be 0 (disabled) but never negative."""
        assert SCORE_DECAY_INTERVAL_SEC >= 0


class TestPackageVersion:
    """Package version follows ``X.Y.Z`` semver format."""

    def test_version_string(self):
        """__version__ is a semver-looking string (3 dotted parts)."""
        assert isinstance(__version__, str)
        parts = __version__.split(".")
        assert len(parts) == 3


class TestCameraCalibration:
    """Per-slot camera calibration: defaults + env overrides."""

    def test_default_calibration_matches_globals(self):
        """DEFAULT_CAMERA_CALIBRATION reflects the global focal/height/horizon constants."""
        from backend.config import (
            CAMERA_FOCAL_PX,
            CAMERA_HEIGHT_M,
            CAMERA_HORIZON_FRAC,
            DEFAULT_CAMERA_CALIBRATION,
        )
        assert DEFAULT_CAMERA_CALIBRATION.focal_px == CAMERA_FOCAL_PX
        assert DEFAULT_CAMERA_CALIBRATION.height_m == CAMERA_HEIGHT_M
        assert DEFAULT_CAMERA_CALIBRATION.horizon_frac == CAMERA_HORIZON_FRAC
        assert DEFAULT_CAMERA_CALIBRATION.orientation == "forward"
        assert DEFAULT_CAMERA_CALIBRATION.bumper_offset_m == 0.0

    def test_primary_slot_uses_front_dashcam_defaults(self):
        """The ``primary`` camera slot uses forward-facing narrow-focal defaults."""
        from backend.config import camera_calibration_for
        cal = camera_calibration_for("primary")
        # Primary intersection camera pointing down the main approach:
        # forward-facing view with a narrow-ish focal length.
        assert cal.focal_px == 600.0
        assert cal.height_m == 1.25
        assert cal.orientation == "forward"
        assert cal.bumper_offset_m == 1.7

    def test_rear_slot_uses_ultrawide_defaults(self):
        """``rear`` slot defaults to ultra-wide focal, rear orientation."""
        from backend.config import camera_calibration_for
        cal = camera_calibration_for("rear")
        # Wide-angle camera covering the far side of the intersection.
        assert cal.focal_px == 260.0
        assert cal.height_m == 1.10
        assert cal.orientation == "rear"
        assert cal.bumper_offset_m == 0.3

    def test_left_slot_marked_side_orientation(self):
        """``left`` slot is tagged side-orientation so distance maths skip ground plane."""
        from backend.config import camera_calibration_for
        cal = camera_calibration_for("left")
        # Side-view camera at the intersection: ground-plane prior is
        # invalid for this orientation; downstream code skips it.
        assert cal.focal_px == 260.0
        assert cal.orientation == "side"
        assert cal.horizon_frac == 0.50  # level mount → horizon at image center
        assert cal.bumper_offset_m == 0.1

    def test_unknown_slot_falls_back_to_default(self):
        """Unknown slot names fall back to the global default calibration."""
        from backend.config import (
            DEFAULT_CAMERA_CALIBRATION,
            camera_calibration_for,
        )
        cal = camera_calibration_for("operator_defined_slot_xyz")
        assert cal == DEFAULT_CAMERA_CALIBRATION

    def test_env_override_per_slot(self, monkeypatch):
        """Per-slot env vars override the slot defaults for their specific fields."""
        from backend.config import camera_calibration_for
        # ``monkeypatch.setenv`` sets an env var for the test and auto-reverts.
        monkeypatch.setenv("ROAD_CAMERA_FOCAL_PX__PRIMARY", "742.5")
        monkeypatch.setenv("ROAD_CAMERA_BUMPER_OFFSET_M__PRIMARY", "2.1")
        cal = camera_calibration_for("primary")
        assert cal.focal_px == 742.5
        assert cal.bumper_offset_m == 2.1
        # Other fields still come from the slot defaults.
        assert cal.orientation == "forward"
        assert cal.height_m == 1.25

    def test_env_override_orientation(self, monkeypatch):
        """Orientation string (forward/rear/side) can be overridden via env."""
        from backend.config import camera_calibration_for
        monkeypatch.setenv("ROAD_CAMERA_ORIENTATION__PRIMARY", "side")
        cal = camera_calibration_for("primary")
        assert cal.orientation == "side"

    def test_unparseable_env_falls_back(self, monkeypatch):
        """Bad numeric override doesn't crash the camera slot — it logs and uses default."""
        from backend.config import camera_calibration_for
        monkeypatch.setenv("ROAD_CAMERA_FOCAL_PX__PRIMARY", "not_a_number")
        cal = camera_calibration_for("primary")
        assert cal.focal_px == 600.0  # falls back to slot default
