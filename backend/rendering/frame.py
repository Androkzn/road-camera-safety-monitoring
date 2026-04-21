"""Per-frame bbox / label rendering for the admin live tile.

Two entry points:

* :func:`render_annotated_frame` — draw class-coloured bboxes + labels +
  interaction lines on a COPY of the frame, return a JPEG byte string
  suitable for MJPEG multipart framing.
* ``WARMING_UP_JPEG`` — module-level constant built once at import; sent
  to MJPEG clients while a slot is booting and has not yet produced its
  first annotated frame.

Extracted from ``server.py`` as part of the refactor plan, step 3.
Behaviour unchanged.
"""

import cv2


def render_annotated_frame(frame, detections, interactions, distances_m=None):
    """Draw bounding boxes and labels on a copy of the frame for the admin feed.

    This is a purely visual helper — the output is fed only to the MJPEG
    admin video feed, not to any compliance-sensitive channel. It operates
    on a COPY so the perception pipeline's shared frame is not mutated.

    Args:
        frame: Raw BGR numpy image.
        detections: Iterable of ``Detection`` dataclasses (with ``.x1/.y1
            /.x2/.y2``, ``.cls``, ``.conf``, ``.track_id``, ``.center``).
        interactions: Iterable of ``(event_type, det_a, det_b, dist_px)``
            tuples — render as coloured connecting lines between pairs.
        distances_m: Optional list of camera-to-object distance estimates
            (metres) aligned 1:1 with ``detections``. ``None`` entries are
            skipped; non-None entries are appended to each bbox label as
            ``"12.3 m"`` so the operator sees how far every tracked object
            is from the camera.

    Returns:
        JPEG-encoded bytes (quality 70 — small enough for MJPEG but
        readable for operators).
    """
    vis = frame.copy()
    # BGR colour map (OpenCV uses BGR, not RGB). Anything unrecognised
    # falls back to neutral grey.
    color_map = {
        "person": (0, 220, 100),
        "car": (255, 160, 0),
        "truck": (255, 100, 0),
        "bus": (200, 80, 200),
        "motorcycle": (0, 180, 255),
    }
    for idx, det in enumerate(detections):
        color = color_map.get(det.cls, (200, 200, 200))
        cv2.rectangle(vis, (det.x1, det.y1), (det.x2, det.y2), color, 2)
        label = f"{det.cls} {det.conf:.0%}"
        if det.track_id is not None:
            label = f"#{det.track_id} {label}"
        if distances_m is not None and idx < len(distances_m):
            d = distances_m[idx]
            if d is not None:
                label = f"{label}  {d:.1f} m"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(vis, (det.x1, det.y1 - th - 6), (det.x1 + tw + 4, det.y1), color, -1)
        cv2.putText(vis, label, (det.x1 + 2, det.y1 - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)

    for event_type, a, b, dist_px in interactions:
        cx_a, cy_a = int(a.center[0]), int(a.center[1])
        cx_b, cy_b = int(b.center[0]), int(b.center[1])
        line_color = (0, 0, 255) if event_type == "pedestrian_proximity" else (0, 165, 255)
        cv2.line(vis, (cx_a, cy_a), (cx_b, cy_b), line_color, 2, cv2.LINE_AA)
        mid_x, mid_y = (cx_a + cx_b) // 2, (cy_a + cy_b) // 2
        cv2.putText(vis, f"{int(dist_px)}px", (mid_x + 4, mid_y - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, line_color, 1, cv2.LINE_AA)

    _, jpeg = cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return jpeg.tobytes()


def _make_placeholder_jpeg() -> bytes:
    """Build a small plain dark-grey placeholder JPEG once at import.

    The MJPEG generator emits this placeholder to slots that have not yet
    published their first annotated frame. Without it, browsers loading the
    multi-source admin page during boot see a connection with no data,
    time out, and render a black tile that never recovers — even after the
    slot starts producing frames a few seconds later.

    The tile is deliberately text-free: cv2.putText at 320x180 looked
    crude when the browser scaled it to a full tile. Any "warming up"
    messaging is rendered in CSS by the frontend so it stays crisp.
    """
    import numpy as np  # local import: avoid pulling numpy on bare module load

    img = np.full((180, 320, 3), 28, dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    if not ok:
        # Defensive fallback: minimal valid JPEG if encoding fails for any reason.
        return (
            b"\xff\xd8\xff\xdb\x00\x43\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07"
            b"\x07\x09\x09\x08\x0a\x0c\x14\x0d\x0c\x0b\x0b\x0c\x19\x12\x13\x0f"
            b"\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c\x20\x24\x2e\x27\x20\x22\x2c"
            b"\x23\x1c\x1c\x28\x37\x29\x2c\x30\x31\x34\x34\x34\x1f\x27\x39\x3d"
            b"\x38\x32\x3c\x2e\x33\x34\x32\xff\xd9"
        )
    return buf.tobytes()


# Build once; reused by every slot's MJPEG generator while it warms up.
WARMING_UP_JPEG: bytes = _make_placeholder_jpeg()
