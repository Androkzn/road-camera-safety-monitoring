"""
Safety event extraction — batch mode (offline analysis of a video file).

Role:
    Reads a recorded video, samples frames at SAMPLE_FPS, runs YOLO detection
    and the shared interaction/risk logic, then writes a JSON event list +
    a trip-level summary + redacted thumbnails. Mirrors the live server's
    hot path but without the streaming / SSE / LLM layers.

Usage:
    python analyze.py data/input.mp4

Outputs (all under ``data/``):
    - ``thumbnails/*.jpg`` — per-event redacted JPEGs (public variant is safe
      to share; internal variant keeps the bounding boxes visible for debug).
    - ``events.json`` — list of event dicts (one per detected interaction).
    - ``summary.json`` — aggregates (trip classification, counts, narrative).

Python concepts used here:
    - ``from __future__ import annotations`` defers type-hint evaluation so
      newer syntax (``list[dict]`` instead of ``List[Dict]``) works on 3.9.
    - ``cv2`` is OpenCV — the video I/O + image ops library.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2

# Reuse the exact same perception primitives the live server uses so batch
# output is comparable to live output.
from backend.core.detection import (
    TrackHistory,
    build_event_summary,
    classify_risk,
    detect_frame,
    estimate_distance_m,
    estimate_ttc_sec,
    find_interactions,
    load_model,
)
from backend.services.redact import public_thumbnail_name, write_thumbnails
from backend.config import DATA_DIR
# Output locations: keep thumbs next to the JSON so a reviewer can see the
# frame that produced each event without reconstructing paths.
THUMBS_DIR = DATA_DIR / "thumbnails"
EVENTS_PATH = DATA_DIR / "events.json"
SUMMARY_PATH = DATA_DIR / "summary.json"

# How many frames per second to evaluate. 2 fps matches the live server's
# TARGET_FPS; higher values cost compute for little recall gain on road video.
SAMPLE_FPS = 2
# Two consecutive events of the same type within this window get merged into
# one (the closer one wins). Prevents a single 3-second near-miss from
# producing 6 separate rows in the output.
EVENT_MERGE_WINDOW_SEC = 2.0


def merge_events(raw: list[dict]) -> list[dict]:
    """Collapse neighbouring events of the same type into one peak event.

    How it works: sort by timestamp, walk the list, and when two adjacent
    entries share ``event_type`` and are within ``EVENT_MERGE_WINDOW_SEC``,
    keep whichever has the smaller ``_distance`` (closer = more critical).
    The ``_distance`` scratch field is stripped before returning.
    """
    merged: list[dict] = []
    for ev in sorted(raw, key=lambda e: e["timestamp_sec"]):
        if merged:
            last = merged[-1]
            same_type = last["event_type"] == ev["event_type"]
            close_in_time = ev["timestamp_sec"] - last["timestamp_sec"] <= EVENT_MERGE_WINDOW_SEC
            if same_type and close_in_time:
                if ev["_distance"] < last["_distance"]:
                    merged[-1] = ev
                continue
        merged.append(ev)
    for ev in merged:
        ev.pop("_distance", None)
    return merged


def build_summary(video_id: str, duration_sec: float, events: list[dict]) -> dict:
    """Return a trip-level summary dict (counts + narrative + classification).

    Classification rule: 2+ high-risk events → ``risky``, 2+ high-or-medium →
    ``moderate``, else ``safe``. Thresholds chosen to match the live server's
    driver-scoring cutoffs.
    """
    # Two tally dicts: by event type ("pedestrian_proximity" → N) and by
    # risk band ("high" → N). ``.get(key, 0) + 1`` is the idiomatic counter
    # increment that avoids KeyError on the first occurrence.
    by_type: dict[str, int] = {}
    by_risk: dict[str, int] = {}
    for ev in events:
        by_type[ev["event_type"]] = by_type.get(ev["event_type"], 0) + 1
        by_risk[ev["risk_level"]] = by_risk.get(ev["risk_level"], 0) + 1

    if by_risk.get("high", 0) >= 2:
        trip_class = "risky"
    elif by_risk.get("high", 0) + by_risk.get("medium", 0) >= 2:
        trip_class = "moderate"
    else:
        trip_class = "safe"

    # List comprehension: build ["3 pedestrian proximity", "1 tailgating"]
    # from the by_type dict in one line. f-strings (``f"{x}"``) interpolate
    # values directly inside a string literal.
    parts = [f"{count} {etype.replace('_', ' ')}" for etype, count in by_type.items()]
    narrative = (
        f"This trip contained {len(events)} safety event(s): " + ", ".join(parts) + "."
        if events
        else "No safety events detected in this trip."
    )

    avg_conf = round(sum(e["confidence"] for e in events) / len(events), 3) if events else 0.0

    return {
        "video_id": video_id,
        "duration_sec": round(duration_sec, 2),
        "trip_classification": trip_class,
        "event_count": len(events),
        "events_by_type": by_type,
        "events_by_risk": by_risk,
        "avg_confidence": avg_conf,
        "narrative": narrative,
    }


def analyze(video_path: Path) -> None:
    """Run the full batch pipeline end-to-end on ``video_path``.

    Flow: open video → sample every Nth frame → detect → track → classify
    interactions → write thumbnails + event rows → merge duplicates →
    persist events.json and summary.json.
    """
    if not video_path.exists():
        # ``sys.exit(msg)`` prints msg to stderr and exits with code 1.
        sys.exit(f"Video not found: {video_path}")

    # Ensure the thumbnails folder exists, then wipe the previous run so
    # stale JPGs don't linger and confuse the operator.
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    for old in THUMBS_DIR.glob("*.jpg"):
        old.unlink()
    for old in THUMBS_DIR.glob("*_public.jpg"):
        old.unlink()

    # ``.stem`` is the filename without the extension; used as video_id.
    video_id = video_path.stem
    # ``VideoCapture`` is OpenCV's file/stream reader. ``cap.get(...)`` pulls
    # metadata like FPS and frame count. ``or 30`` is a safe default for
    # files whose metadata claims 0 fps.
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = total_frames / fps
    # Process every ``step``-th frame so we land near SAMPLE_FPS. ``max(..., 1)``
    # guards against a division that would yield 0 on slow videos.
    step = max(int(fps / SAMPLE_FPS), 1)

    print(f"Video: {video_id}  fps={fps:.1f}  frames={total_frames}  duration={duration_sec:.1f}s")
    print(f"Sampling every {step} frames (~{SAMPLE_FPS} fps)")

    model = load_model()
    track_history = TrackHistory()

    raw_events: list[dict] = []
    frame_idx = 0
    processed = 0
    started = time.time()

    # Read every frame; drop the ones we don't sample. ``cap.read()`` returns
    # ``(ok, frame)`` where ``ok=False`` means EOF.
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # ``%`` is modulo; only every step-th frame passes the gate.
        if frame_idx % step != 0:
            frame_idx += 1
            continue

        timestamp = frame_idx / fps
        # Run YOLO: returns a list of Detection dataclasses with bbox + class.
        detections = detect_frame(model, frame)
        # ``frame.shape`` on an OpenCV image = (height, width, channels).
        frame_h = frame.shape[0]
        # Track which tracker IDs are present this frame so we can prune
        # stale histories afterwards.
        live_ids: set[int] = set()
        for det in detections:
            if det.track_id is not None:
                live_ids.add(det.track_id)
                track_history.update(det, timestamp)
        track_history.prune(live_ids, timestamp)

        # Each interaction is a (type, det_a, det_b, pixel_distance) tuple.
        # We compute time-to-collision and metres-to-target by picking the
        # worst (smallest) candidate across the two participants.
        for event_type, a, b, distance in find_interactions(detections):
            ttc = None
            for sub in (a, b):
                cand = estimate_ttc_sec(track_history.samples(sub.track_id))
                if cand is not None and (ttc is None or cand < ttc):
                    ttc = cand
            dist_m = None
            for sub in (a, b):
                cand = estimate_distance_m(sub, frame_h)
                if cand is not None and (dist_m is None or cand < dist_m):
                    dist_m = cand
            risk = classify_risk(ttc, dist_m, distance)
            # Alert fatigue guard: a low-risk pedestrian encounter isn't
            # actionable. Skip it entirely rather than emit + hope someone
            # filters it in the UI.
            if event_type == "pedestrian_proximity" and risk == "low":
                continue
            # ``:04d`` zero-pads the integer to 4 digits (evt_0001, evt_0002).
            event_id = f"evt_{len(raw_events):04d}"
            internal_name = f"{event_id}.jpg"
            public_name = public_thumbnail_name(internal_name)
            # Emit two thumbnails: one with debug overlays (internal) and one
            # with plate/face redaction applied (public, safe to share).
            write_thumbnails(
                frame, detections, a, b,
                THUMBS_DIR / internal_name,
                THUMBS_DIR / public_name,
            )
            raw_events.append(
                {
                    "event_id": event_id,
                    "video_id": video_id,
                    "timestamp_sec": round(timestamp, 2),
                    "event_type": event_type,
                    "risk_level": risk,
                    "confidence": round(min(a.conf, b.conf), 3),
                    "objects": sorted({a.cls, b.cls}),
                    "track_ids": [t for t in (a.track_id, b.track_id) if t is not None],
                    "ttc_sec": ttc,
                    "distance_m": dist_m,
                    "distance_px": round(distance, 1),
                    "summary": build_event_summary(
                        event_type, a, b, distance, risk,
                        ttc_sec=ttc, distance_m=dist_m,
                    ),
                    "thumbnail": f"thumbnails/{public_name}",
                    "_distance": distance,
                }
            )
        processed += 1
        frame_idx += 1

    # Always release the video handle — leaking a capture pins the file
    # open on Windows and blocks follow-up analyses.
    cap.release()

    # Coalesce near-duplicate events and re-assign compact event_ids.
    events = merge_events(raw_events)
    for i, ev in enumerate(events):
        ev["event_id"] = f"evt_{i:04d}"

    # ``json.dumps(..., indent=2)`` pretty-prints the JSON so a human can
    # diff event lists in a PR review.
    EVENTS_PATH.write_text(json.dumps(events, indent=2))
    summary = build_summary(video_id, duration_sec, events)
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2))

    elapsed = time.time() - started
    print(
        f"Done. Processed {processed} frames in {elapsed:.1f}s "
        f"({processed / max(elapsed, 1e-6):.1f} fps). "
        f"Wrote {len(events)} event(s)."
    )


# ``if __name__ == "__main__":`` — runs only when this file is executed
# directly (not when it's imported). ``sys.argv`` is the list of CLI args;
# ``sys.argv[0]`` is the script name, ``[1]`` is the first user argument.
if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python analyze.py <video_path>")
    analyze(Path(sys.argv[1]))
