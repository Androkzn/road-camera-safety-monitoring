"""Demo GPS track — parses the bundled ``location-history.json`` into a
flat, loopable path for the frontend map overlay.

Role:
    The demo dashcam MP4 replays forever (see ``StreamReader`` loop mode).
    We want an accompanying map tile that shows the "vehicle" moving along
    a plausible route while the MP4 plays. This module converts the Google-
    Takeout-style ``location-history.json`` into a single ordered list of
    ``(lat, lng, t_sec)`` waypoints and caches the result so every request
    reads from memory instead of re-parsing.

Why a flat list:
    The source file interleaves ``visit`` / ``activity`` / ``timelinePath``
    entries; only ``timelinePath`` carries actual waypoints with a
    ``point: "geo:LAT,LNG"`` and ``durationMinutesOffsetFromStartTime``.
    We walk every ``timelinePath`` and concatenate its points into one
    continuous loop, offsetting later segments so the total duration grows
    monotonically. That lets the frontend animate a single polyline and
    interpolate position by ``wallclock_sec % total_duration_sec``.

No ``from __future__ import annotations`` — we rely on the 3.10+ union
syntax at runtime (module is imported once at server boot).
"""

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from road_safety.config import PROJECT_ROOT

log = logging.getLogger(__name__)

# Fixed location relative to the project root. If the operator deletes the
# file the endpoint returns ``{ok: false}`` rather than crashing the app.
_TRACK_FILE = PROJECT_ROOT / "resourses" / "location-history.json"


@dataclass(frozen=True)
class TrackPoint:
    """One waypoint on the demo loop — immutable for cache safety."""

    lat: float
    lng: float
    # Seconds since the start of the (concatenated) loop. Monotonically
    # non-decreasing within a cached track.
    t_sec: float


# Module-level cache. Populated by ``load_track()`` on first call; later
# calls are O(1). The server only parses once per process — the file
# doesn't change at runtime and a ~200-line JSON re-parse on every
# request is wasteful when the map polls every second or two.
_CACHE: dict[str, Any] | None = None


def _parse_geo(point: str) -> tuple[float, float] | None:
    """Parse a ``"geo:LAT,LNG"`` string into a ``(lat, lng)`` tuple.

    Returns ``None`` if the string is malformed — callers drop bad points
    rather than crash, because the source file is user-provided data that
    may contain typos or schema drift.
    """
    if not isinstance(point, str) or not point.startswith("geo:"):
        return None
    try:
        lat_s, lng_s = point[4:].split(",", 1)
        return float(lat_s), float(lng_s)
    except ValueError:
        return None


def _extract_points(raw: list[Any]) -> list[TrackPoint]:
    """Flatten every ``timelinePath`` in ``raw`` into one continuous list.

    Each segment's ``durationMinutesOffsetFromStartTime`` resets to 0 at its
    own start — we accumulate a running ``segment_base_sec`` so the returned
    ``t_sec`` values are monotonically non-decreasing across segments. A tiny
    +1s gap between segments avoids zero-length "teleport" edges in the
    interpolator on the frontend.
    """
    pts: list[TrackPoint] = []
    segment_base_sec = 0.0
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        path = entry.get("timelinePath")
        if not isinstance(path, list):
            continue

        segment_max_sec = 0.0
        for wp in path:
            if not isinstance(wp, dict):
                continue
            latlng = _parse_geo(wp.get("point", ""))
            if latlng is None:
                continue
            try:
                minute_off = float(wp.get("durationMinutesOffsetFromStartTime", 0))
            except (TypeError, ValueError):
                minute_off = 0.0
            t_sec = segment_base_sec + minute_off * 60.0
            pts.append(TrackPoint(lat=latlng[0], lng=latlng[1], t_sec=t_sec))
            if t_sec > segment_max_sec:
                segment_max_sec = t_sec

        # Advance the base past this segment's longest offset so the next
        # segment's minute-0 sits *after* this segment ends.
        if segment_max_sec > segment_base_sec:
            segment_base_sec = segment_max_sec + 1.0

    return pts


def _build_cache() -> dict[str, Any]:
    """Read, parse, and freeze the track + basic aggregates.

    The returned dict is the exact shape the ``/api/demo/track`` endpoint
    returns (plus a Python ``points`` list of ``TrackPoint`` — which FastAPI
    serialises as dicts because of the ``dataclass`` annotation).
    """
    if not _TRACK_FILE.exists():
        log.warning("demo track file missing: %s", _TRACK_FILE)
        return {
            "ok": False,
            "error": f"track file not found: {_TRACK_FILE.name}",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }
    try:
        raw = json.loads(_TRACK_FILE.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("demo track load failed: %s", exc)
        return {
            "ok": False,
            "error": f"failed to parse track: {exc}",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }

    if not isinstance(raw, list):
        return {
            "ok": False,
            "error": "track root is not a list",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }

    points = _extract_points(raw)
    if not points:
        return {
            "ok": False,
            "error": "no usable timelinePath points in track file",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }

    total = points[-1].t_sec if points else 0.0
    lats = [p.lat for p in points]
    lngs = [p.lng for p in points]
    bounds = {
        "south": min(lats),
        "west": min(lngs),
        "north": max(lats),
        "east": max(lngs),
    }

    log.info(
        "demo track loaded: %d points spanning %.1fs (bounds=%s)",
        len(points),
        total,
        bounds,
    )
    return {
        "ok": True,
        "points": [
            {"lat": p.lat, "lng": p.lng, "t_sec": p.t_sec} for p in points
        ],
        "total_duration_sec": total,
        "bounds": bounds,
    }


def load_track() -> dict[str, Any]:
    """Return the cached, JSON-serialisable track payload.

    Callers should treat the returned dict as read-only — it's shared by
    every request. Mutating it would corrupt future responses.
    """
    global _CACHE
    if _CACHE is None:
        _CACHE = _build_cache()
    return _CACHE


def reset_cache_for_tests() -> None:
    """Drop the in-memory cache so a test can re-parse after monkeypatching.

    Exposed solely for tests; production code should never need to call
    this (the track file doesn't change at runtime).
    """
    global _CACHE
    _CACHE = None


# ---------------------------------------------------------------------------
# Video-synced variant — slice the Timeline to the window of a real recording
# ---------------------------------------------------------------------------


def _parse_iso_utc(value: str) -> datetime | None:
    """Parse an ISO-8601 timestamp into an aware UTC datetime. ``None`` on failure."""
    if not isinstance(value, str) or not value:
        return None
    # Normalise the trailing Z — fromisoformat only accepts it from 3.11,
    # and we still support 3.10.
    cleaned = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _extract_points_in_window(
    raw: list[Any],
    window_start: datetime,
    window_end: datetime,
) -> list[TrackPoint]:
    """Return the Timeline waypoints that fall inside ``[window_start, window_end]``.

    Each waypoint's ``t_sec`` is re-based so ``t_sec == 0`` means
    ``window_start`` (i.e. the beginning of the video). Waypoints outside
    the window are dropped. Segments whose entire wallclock span sits
    outside the window are skipped cheaply without scanning their points.
    """
    pts: list[TrackPoint] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        path = entry.get("timelinePath")
        if not isinstance(path, list):
            continue
        seg_start = _parse_iso_utc(entry.get("startTime", ""))
        seg_end = _parse_iso_utc(entry.get("endTime", ""))
        if seg_start is None:
            continue
        # Fast reject: entire segment ends before window starts, or starts
        # after window ends. The second clause uses seg_start only — segments
        # without endTime still pass through to per-waypoint filtering.
        if seg_end is not None and seg_end < window_start:
            continue
        if seg_start > window_end:
            continue

        for wp in path:
            if not isinstance(wp, dict):
                continue
            latlng = _parse_geo(wp.get("point", ""))
            if latlng is None:
                continue
            try:
                minute_off = float(wp.get("durationMinutesOffsetFromStartTime", 0))
            except (TypeError, ValueError):
                minute_off = 0.0
            wp_wall = seg_start.timestamp() + minute_off * 60.0
            if (
                wp_wall < window_start.timestamp()
                or wp_wall > window_end.timestamp()
            ):
                continue
            t_sec = wp_wall - window_start.timestamp()
            pts.append(TrackPoint(lat=latlng[0], lng=latlng[1], t_sec=t_sec))
    pts.sort(key=lambda p: p.t_sec)
    return pts


def load_track_for_window(
    start_iso_utc: str,
    duration_sec: float,
) -> dict[str, Any]:
    """Return a track payload scoped to ``[start_iso_utc, +duration_sec]``.

    Unlike :func:`load_track` (which flattens the whole Timeline into a
    loopable path), this variant re-bases ``t_sec`` so ``0`` is the
    video's first frame. The frontend can then drive the map marker
    directly from video playback time — no wallclock compression needed.

    Returned shape matches :func:`load_track` so the same frontend hook
    can consume it.

    No caching: the inputs (start/duration) are per-video, and parsing
    the JSON a handful of times at server boot is negligible.
    """
    window_start = _parse_iso_utc(start_iso_utc)
    if window_start is None or duration_sec <= 0:
        return {
            "ok": False,
            "error": f"invalid window: start={start_iso_utc!r} duration={duration_sec}",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }
    window_end = datetime.fromtimestamp(
        window_start.timestamp() + duration_sec, tz=timezone.utc,
    )

    if not _TRACK_FILE.exists():
        log.warning("demo track file missing: %s", _TRACK_FILE)
        return {
            "ok": False,
            "error": f"track file not found: {_TRACK_FILE.name}",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }
    try:
        raw = json.loads(_TRACK_FILE.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("demo track load failed: %s", exc)
        return {
            "ok": False,
            "error": f"failed to parse track: {exc}",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }
    if not isinstance(raw, list):
        return {
            "ok": False,
            "error": "track root is not a list",
            "points": [],
            "total_duration_sec": 0.0,
            "bounds": None,
        }

    points = _extract_points_in_window(raw, window_start, window_end)
    if not points:
        return {
            "ok": False,
            "error": (
                f"no timelinePath waypoints in window "
                f"[{window_start.isoformat()}, {window_end.isoformat()}]"
            ),
            "points": [],
            "total_duration_sec": duration_sec,
            "bounds": None,
        }

    lats = [p.lat for p in points]
    lngs = [p.lng for p in points]
    log.info(
        "demo track windowed: %d points in [%s, %s]",
        len(points),
        window_start.isoformat(),
        window_end.isoformat(),
    )
    return {
        "ok": True,
        "points": [
            {"lat": p.lat, "lng": p.lng, "t_sec": p.t_sec} for p in points
        ],
        "total_duration_sec": duration_sec,
        "bounds": {
            "south": min(lats),
            "west": min(lngs),
            "north": max(lats),
            "east": max(lngs),
        },
    }
