"""Shared test fixtures for the Road Safety test suite.

pytest discovers this file by name (``conftest.py``) and makes every fixture
defined here available to any test in the same directory tree, with no import
required. Think of it as "test-time dependency injection".

Quick glossary (Python / pytest features used below):

    * ``@pytest.fixture`` — a decorator that turns a function into a reusable
      resource. Tests ask for it by listing the fixture name as a parameter;
      pytest calls the fixture and passes its return value in.
    * ``autouse=True`` — the fixture runs for *every* test in scope, even if
      the test doesn't name it. Used here so data-dir isolation is automatic.
    * ``tmp_path`` — built-in pytest fixture: a unique, per-test temp
      directory as a ``pathlib.Path``. Cleaned up automatically.
    * ``monkeypatch`` — built-in pytest fixture that can swap attributes /
      env vars / items on objects for the duration of the test, reverting
      everything at teardown. Safer than manually saving/restoring globals.
    * ``yield`` inside a fixture — everything before ``yield`` is setup,
      everything after is teardown. The yielded value is what the test sees.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Redirect DATA_DIR / THUMBS_DIR to a temp directory for every test.

    Without this, tests would read/write the real ``data/`` directory and
    stomp on each other (and on the dev's local state). Pointing DATA_DIR at
    ``tmp_path`` per test guarantees hermetic test runs.

    ``autouse=True`` + parameter-less invocation means this fixture is
    active everywhere with no test-side boilerplate.
    """
    data = tmp_path / "data"
    data.mkdir()
    (data / "thumbnails").mkdir()
    (data / "corpus").mkdir()
    (data / "active_learning" / "pending").mkdir(parents=True)

    monkeypatch.setattr("backend.config.DATA_DIR", data)
    monkeypatch.setattr("backend.config.THUMBS_DIR", data / "thumbnails")
    monkeypatch.setattr("backend.config.CORPUS_DIR", data / "corpus")
    yield data


@pytest.fixture()
def sample_detection():
    """A minimal Detection object for unit tests (pedestrian bbox)."""
    # Local import keeps top-level import graph clean and lets tests that
    # don't need this fixture skip loading the detection module.
    from backend.core.detection import Detection
    return Detection(cls="person", conf=0.85, x1=100, y1=200, x2=160, y2=400, track_id=7)


@pytest.fixture()
def sample_vehicle():
    """A minimal Detection object standing in for a detected car."""
    from backend.core.detection import Detection
    return Detection(cls="car", conf=0.92, x1=300, y1=250, x2=500, y2=450, track_id=12)


@pytest.fixture()
def sample_event():
    """A complete event dict matching the shape produced by the emit pipeline.

    Handy for tests that exercise code consuming events (Slack notifier,
    edge publisher, registry) without forcing each test to hand-roll one.
    """
    return {
        "event_id": "evt_1700000000000_0001",
        "vehicle_id": "vehicle_01",
        "road_id": "road_test",
        "driver_id": "driver_01",
        "video_id": "live_stream",
        "timestamp_sec": 12.5,
        "wall_time": "2026-04-15T10:00:00Z",
        "event_type": "pedestrian_proximity",
        "risk_level": "high",
        "confidence": 0.82,
        "objects": ["car", "person"],
        "track_ids": [7, 12],
        "episode_duration_sec": 1.5,
        "ttc_sec": 1.2,
        "distance_m": 2.8,
        "distance_px": 45.0,
        "summary": "Person and car within 45px (risk=high).",
        "narration": None,
        "thumbnail": "thumbnails/evt_1700000000000_0001_public.jpg",
    }


@pytest.fixture()
def mock_yolo_model():
    """A MagicMock standing in for the YOLO model so we never load weights in tests.

    ``MagicMock`` auto-creates attributes and methods on access, returning
    further MagicMocks. ``model.track.return_value = [...]`` scripts what a
    specific method call returns — letting us fake detection results without
    any torch / ultralytics dependency at test time.
    """
    model = MagicMock()
    model.track.return_value = [MagicMock(
        names={0: "person", 2: "car"},
        boxes=None,
    )]
    model.return_value = [MagicMock(
        names={0: "person", 2: "car"},
        boxes=None,
    )]
    return model
