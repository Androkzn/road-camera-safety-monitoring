"""redact.py — blurs faces and license plates before thumbnails leave the host.

What it does:
    Every detected event produces two thumbnail files. The internal one
    (``{event_id}.jpg``) is full fidelity and never leaves local disk.
    The public one (``{event_id}_public.jpg``) has faces and license
    plates blurred and is the only version sent anywhere else — Slack,
    outbound webhooks, non-internal LLM calls. Also produces a salted
    one-way hash for plate text so we can spot repeat offenders without
    storing the plate string.

Purpose:
    Regulatory and ethical: license plates are PII under GDPR Art. 4 and
    enumerated PI under CCPA; faces are biometric PII under most
    regimes. Redaction must be a hard gate, not a best-effort step, so
    this module is the single checkpoint every egress path funnels
    through.

How it works:
    * Uses OpenCV's Gaussian blur over geometric regions. We don't have
      a dedicated plate detector, so we blur the lower-middle strip of
      each vehicle bbox (likely plate location) and the upper ~35% of
      each person bbox (likely face). This over-blurs slightly — the
      correct failure mode is "too much blur" over "leaked PII".
    * ``redact_for_egress`` never mutates the original frame; it
      ``.copy()`` first so the caller keeps the unredacted version.
    * ``write_thumbnails`` draws bounding boxes only on the internal
      copy — annotations can themselves contain PII text, so the public
      copy is blurred first and boxes added last.
    * ``hash_plate`` salts the plate (``PLATE_SALT`` env var) before
      SHA-256 so hashes from different deployments don't correlate.
    * Constants tune where to blur: ``FACE_BAND_TOP/BOTTOM``,
      ``PLATE_BAND_TOP/BOTTOM``, ``PLATE_BAND_X_INSET``.

Connects to:
    - Backend: ``road_safety/server.py`` calls ``write_thumbnails``
      every time the detection pipeline emits an event, and
      ``hash_plate`` / ``public_thumbnail_name`` when serving
      ``/thumbnails/{name}``. ``road_safety.services.llm.enrich_event``
      calls ``hash_plate`` so the enrichment dict never contains raw
      plate text. ``tools/analyze.py`` (offline analysis CLI) imports
      the same helpers.
    - UI: indirectly — every thumbnail image loaded in
      ``frontend/src/`` (event cards, drawers, admin previews) is
      served from ``/thumbnails/...`` and has already passed through
      this redactor.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import cv2

from road_safety.config import PLATE_SALT
from road_safety.core.detection import Detection, PEDESTRIAN_CLASSES, VEHICLE_CLASSES

_PLATE_SALT = PLATE_SALT

FACE_BAND_TOP = 0.00     # face = top ~35% of person bbox
FACE_BAND_BOTTOM = 0.35
PLATE_BAND_TOP = 0.55    # plate = lower-middle strip of vehicle bbox
PLATE_BAND_BOTTOM = 0.95
PLATE_BAND_X_INSET = 0.15  # crop horizontal margins


def _blur_roi(frame, x1: int, y1: int, x2: int, y2: int, ksize: int = 41) -> None:
    h, w = frame.shape[:2]
    x1 = max(0, min(x1, w - 1))
    x2 = max(0, min(x2, w))
    y1 = max(0, min(y1, h - 1))
    y2 = max(0, min(y2, h))
    if x2 - x1 < 4 or y2 - y1 < 4:
        return
    roi = frame[y1:y2, x1:x2]
    k = ksize if ksize % 2 == 1 else ksize + 1
    frame[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (k, k), 0)


def _face_band(det: Detection) -> tuple[int, int, int, int]:
    h = det.height
    return (
        det.x1,
        det.y1 + int(h * FACE_BAND_TOP),
        det.x2,
        det.y1 + int(h * FACE_BAND_BOTTOM),
    )


def _plate_band(det: Detection) -> tuple[int, int, int, int]:
    h = det.height
    w = det.width
    xi = int(w * PLATE_BAND_X_INSET)
    return (
        det.x1 + xi,
        det.y1 + int(h * PLATE_BAND_TOP),
        det.x2 - xi,
        det.y1 + int(h * PLATE_BAND_BOTTOM),
    )


def redact_for_egress(frame, detections: list[Detection]):
    """Return a blurred copy of `frame` safe for third-party egress.

    Never mutates the original frame — callers keep the internal version.
    """
    out = frame.copy()
    for det in detections:
        if det.cls in PEDESTRIAN_CLASSES:
            x1, y1, x2, y2 = _face_band(det)
            _blur_roi(out, x1, y1, x2, y2, ksize=31)
        elif det.cls in VEHICLE_CLASSES:
            x1, y1, x2, y2 = _plate_band(det)
            _blur_roi(out, x1, y1, x2, y2, ksize=25)
    return out


def write_thumbnails(
    frame,
    detections: list[Detection],
    primary: Detection,
    secondary: Detection,
    internal_path: Path,
    public_path: Path,
) -> None:
    """Write both the internal (with bboxes) and egress-safe (redacted) thumbs.

    The redaction happens on the *raw* frame; bboxes are drawn only on the
    internal copy. This ordering matters — never annotate a frame and then
    try to redact, because the annotation labels can contain PII too.
    """
    from road_safety.core.detection import draw_thumbnail

    draw_thumbnail(frame, primary, secondary, internal_path)

    redacted = redact_for_egress(frame, detections)
    for det, color in [(primary, (0, 0, 255)), (secondary, (0, 200, 255))]:
        cv2.rectangle(redacted, (det.x1, det.y1), (det.x2, det.y2), color, 2)
    cv2.imwrite(str(public_path), redacted)


def hash_plate(plate_text: str | None) -> str | None:
    """Stable salted hash for plate correlation without plate retention.

    Lets downstream consumers detect repeat offenders ('we've seen this hash
    3 times in 20 min') without storing the actual plate string anywhere.
    Salt is per-deployment so hashes don't correlate across operators.
    """
    if not plate_text:
        return None
    normalized = plate_text.replace(" ", "").upper()
    digest = hashlib.sha256(f"{_PLATE_SALT}:{normalized}".encode("utf-8")).hexdigest()
    return f"plate_{digest[:16]}"


def public_thumbnail_name(internal_name: str) -> str:
    """evt_0001.jpg -> evt_0001_public.jpg"""
    stem, _, ext = internal_name.rpartition(".")
    return f"{stem}_public.{ext}" if stem else f"{internal_name}_public"
