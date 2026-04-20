"""Tests for road_safety.services.demo_track.load_track_for_window.

Synthesises Timeline-JSON-shaped input rather than reading the bundled
file so the behaviour is exercised deterministically regardless of what
ships in ``resourses/``.
"""

import json
from pathlib import Path

from road_safety.services import demo_track


def _write_timeline(path: Path, entries: list) -> None:
    path.write_text(json.dumps(entries))


def test_window_slices_and_rebases_t_sec(tmp_path: Path, monkeypatch):
    track_file = tmp_path / "timeline.json"
    _write_timeline(
        track_file,
        [
            {
                "startTime": "2026-04-19T22:00:00.000Z",
                "endTime": "2026-04-19T23:00:00.000Z",
                "timelinePath": [
                    # wallclock 22:00 → inside window
                    {"point": "geo:49.10,-122.80", "durationMinutesOffsetFromStartTime": "0"},
                    # wallclock 22:05 → inside window
                    {"point": "geo:49.11,-122.81", "durationMinutesOffsetFromStartTime": "5"},
                    # wallclock 22:30 → inside window
                    {"point": "geo:49.12,-122.82", "durationMinutesOffsetFromStartTime": "30"},
                    # wallclock 22:59 → outside window (video ends at 22:30)
                    {"point": "geo:49.13,-122.83", "durationMinutesOffsetFromStartTime": "59"},
                ],
            }
        ],
    )
    monkeypatch.setattr(demo_track, "_TRACK_FILE", track_file)

    # Video: starts 22:00 UTC, duration 30 min → window [22:00, 22:30].
    payload = demo_track.load_track_for_window(
        start_iso_utc="2026-04-19T22:00:00Z",
        duration_sec=30 * 60,
    )

    assert payload["ok"] is True
    # 3 waypoints inside the window; the 22:59 one is dropped.
    assert len(payload["points"]) == 3
    # t_sec is re-based to the video: first waypoint at 22:00 → t_sec = 0.
    assert payload["points"][0]["t_sec"] == 0
    # Second at 22:05 → 300s after video start.
    assert payload["points"][1]["t_sec"] == 300
    # Third at 22:30 → 1800s after video start, exactly at the boundary.
    assert payload["points"][2]["t_sec"] == 1800
    assert payload["total_duration_sec"] == 1800


def test_window_returns_ok_false_when_no_waypoints_in_range(tmp_path: Path, monkeypatch):
    track_file = tmp_path / "timeline.json"
    _write_timeline(
        track_file,
        [
            {
                "startTime": "2026-04-19T10:00:00.000Z",
                "endTime": "2026-04-19T11:00:00.000Z",
                "timelinePath": [
                    {"point": "geo:49.1,-122.8", "durationMinutesOffsetFromStartTime": "0"},
                ],
            }
        ],
    )
    monkeypatch.setattr(demo_track, "_TRACK_FILE", track_file)

    # Window is hours later — no overlap.
    payload = demo_track.load_track_for_window(
        start_iso_utc="2026-04-19T22:00:00Z",
        duration_sec=300,
    )

    assert payload["ok"] is False
    assert "no timelinePath waypoints" in payload["error"]
    assert payload["points"] == []


def test_window_rejects_invalid_start_iso(tmp_path: Path, monkeypatch):
    track_file = tmp_path / "timeline.json"
    _write_timeline(track_file, [])
    monkeypatch.setattr(demo_track, "_TRACK_FILE", track_file)

    payload = demo_track.load_track_for_window(start_iso_utc="not-a-date", duration_sec=60)

    assert payload["ok"] is False
    assert "invalid window" in payload["error"]


def test_window_rejects_non_positive_duration(tmp_path: Path, monkeypatch):
    track_file = tmp_path / "timeline.json"
    _write_timeline(track_file, [])
    monkeypatch.setattr(demo_track, "_TRACK_FILE", track_file)

    payload = demo_track.load_track_for_window(
        start_iso_utc="2026-04-19T22:00:00Z", duration_sec=0,
    )

    assert payload["ok"] is False


def test_window_skips_segments_outside_fast_path(tmp_path: Path, monkeypatch):
    """Segments whose entire span sits outside the window shouldn't leak points."""
    track_file = tmp_path / "timeline.json"
    _write_timeline(
        track_file,
        [
            # segment fully before the window
            {
                "startTime": "2026-04-19T10:00:00.000Z",
                "endTime": "2026-04-19T11:00:00.000Z",
                "timelinePath": [
                    {"point": "geo:49.0,-122.0", "durationMinutesOffsetFromStartTime": "5"},
                ],
            },
            # segment overlapping the window (one waypoint inside, one outside)
            {
                "startTime": "2026-04-19T22:00:00.000Z",
                "endTime": "2026-04-19T23:00:00.000Z",
                "timelinePath": [
                    {"point": "geo:49.10,-122.80", "durationMinutesOffsetFromStartTime": "5"},
                    {"point": "geo:49.15,-122.85", "durationMinutesOffsetFromStartTime": "55"},
                ],
            },
            # segment fully after the window
            {
                "startTime": "2026-04-20T00:00:00.000Z",
                "endTime": "2026-04-20T01:00:00.000Z",
                "timelinePath": [
                    {"point": "geo:49.9,-122.9", "durationMinutesOffsetFromStartTime": "0"},
                ],
            },
        ],
    )
    monkeypatch.setattr(demo_track, "_TRACK_FILE", track_file)

    # Window: 22:00 → 22:30. Only the 22:05 waypoint qualifies.
    payload = demo_track.load_track_for_window(
        start_iso_utc="2026-04-19T22:00:00Z", duration_sec=30 * 60,
    )

    assert payload["ok"] is True
    assert len(payload["points"]) == 1
    assert payload["points"][0]["t_sec"] == 300
    assert payload["points"][0]["lat"] == 49.10
