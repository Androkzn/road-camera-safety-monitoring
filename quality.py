import threading
import time
import cv2
import numpy as np

STATES = [
    "nominal",
    "degraded_low_light",
    "degraded_blur",
    "degraded_low_confidence",
    "degraded_overexposed",
]

_ALPHA_FRAME = 0.05
_ALPHA_CONF = 0.02
_MAX_WIDTH = 480

_THRESH = {
    "overexposed_sat": 0.25,
    "overexposed_lum": 220.0,
    "low_light_lum": 45.0,
    "blur_sharp": 40.0,
    "low_conf": 0.42,
    "low_conf_min_samples": 60,
}

_HYST = 1.20  # require 20% past threshold to recover to nominal

_RISK = {
    "nominal": {"skip_vision_enrichment": False, "ttc_multiplier": 1.0, "pixel_dist_multiplier": 1.0},
    "degraded_low_light": {"skip_vision_enrichment": True, "ttc_multiplier": 1.7, "pixel_dist_multiplier": 1.3},
    "degraded_blur": {"skip_vision_enrichment": True, "ttc_multiplier": 1.5, "pixel_dist_multiplier": 1.2},
    "degraded_low_confidence": {"skip_vision_enrichment": True, "ttc_multiplier": 1.3, "pixel_dist_multiplier": 1.1},
    "degraded_overexposed": {"skip_vision_enrichment": True, "ttc_multiplier": 1.5, "pixel_dist_multiplier": 1.3},
}


class QualityMonitor:
    def __init__(self, window_sec: float = 300.0, log: bool = True):
        """Perception-quality monitor for a live YOLO dashcam pipeline.

        Computes cheap per-frame features (luminance, sharpness, saturated-pixel
        fraction) plus a slow EWMA of detection confidence, classifies the
        pipeline into a degradation state with hysteresis, and exposes a
        risk-adjustment dict that the downstream policy layer can consume.
        """
        self.window_sec = float(window_sec)
        self.log = bool(log)
        self._lock = threading.Lock()
        self._lum = None
        self._sharp = None
        self._sat = None
        self._conf = None
        self._samples = 0
        self._state = "nominal"
        self._state_since = time.time()
        self._last_reason = "warmup"

    def observe_frame(self, frame, detections: list, now: float) -> None:
        if frame is None:
            return
        try:
            h, w = frame.shape[:2]
            if w > _MAX_WIDTH:
                scale = _MAX_WIDTH / float(w)
                small = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            else:
                small = frame
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            lum = float(cv2.mean(gray)[0])
            sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            sat = float(np.mean((gray > 240) | (gray < 15)))
        except Exception:
            return

        conf_sample = None
        if detections:
            try:
                vals = [float(d.conf) for d in detections if getattr(d, "conf", None) is not None]
                if vals:
                    conf_sample = sum(vals) / len(vals)
            except Exception:
                conf_sample = None

        with self._lock:
            self._lum = lum if self._lum is None else (1 - _ALPHA_FRAME) * self._lum + _ALPHA_FRAME * lum
            self._sharp = sharp if self._sharp is None else (1 - _ALPHA_FRAME) * self._sharp + _ALPHA_FRAME * sharp
            self._sat = sat if self._sat is None else (1 - _ALPHA_FRAME) * self._sat + _ALPHA_FRAME * sat
            if conf_sample is not None:
                self._conf = conf_sample if self._conf is None else (1 - _ALPHA_CONF) * self._conf + _ALPHA_CONF * conf_sample
            self._samples += 1
            self._reclassify(now)

    def _reclassify(self, now: float) -> None:
        lum = self._lum
        sharp = self._sharp
        sat = self._sat
        conf = self._conf
        samples = self._samples
        cur = self._state

        def trip(metric, thresh, direction, hyst):
            # direction: "above" means degraded when metric > thresh
            if metric is None:
                return False
            if direction == "above":
                t = thresh * _HYST if hyst else thresh
                return metric > t
            else:
                t = thresh / _HYST if hyst else thresh
                return metric < t

        # For overexposed we need both saturated_pct AND luminance high.
        def over_trip(hyst):
            if sat is None or lum is None:
                return False
            if hyst:
                return sat > _THRESH["overexposed_sat"] * _HYST and lum > _THRESH["overexposed_lum"] * _HYST
            return sat > _THRESH["overexposed_sat"] and lum > _THRESH["overexposed_lum"]

        def low_conf_trip(hyst):
            if conf is None or samples <= _THRESH["low_conf_min_samples"]:
                return False
            t = _THRESH["low_conf"] / _HYST if hyst else _THRESH["low_conf"]
            return conf < t

        # Hysteresis: if we're already in a degraded state, use the harder
        # threshold (must improve 20% past trigger) to leave it.
        new_state = "nominal"
        reason = "metrics within nominal range"

        if over_trip(hyst=(cur == "degraded_overexposed")):
            new_state = "degraded_overexposed"
            reason = f"overexposed (sat={sat:.2f}, lum={lum:.1f})"
        elif trip(lum, _THRESH["low_light_lum"], "below", hyst=(cur == "degraded_low_light")):
            new_state = "degraded_low_light"
            reason = f"low light (luminance={lum:.1f})"
        elif trip(sharp, _THRESH["blur_sharp"], "below", hyst=(cur == "degraded_blur")):
            new_state = "degraded_blur"
            reason = f"blurred / dirty lens (sharpness={sharp:.1f})"
        elif low_conf_trip(hyst=(cur == "degraded_low_confidence")):
            new_state = "degraded_low_confidence"
            reason = f"detector confidence low (avg={conf:.2f})"

        self._last_reason = reason
        if new_state != cur:
            old = cur
            self._state = new_state
            self._state_since = now if now else time.time()
            if self.log:
                lum_s = f"{lum:.1f}" if lum is not None else "n/a"
                sharp_s = f"{sharp:.1f}" if sharp is not None else "n/a"
                print(f"[quality] state: {old} -> {new_state} (luminance={lum_s}, sharpness={sharp_s})")

    def state(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "reason": self._last_reason,
                "luminance": self._lum,
                "sharpness": self._sharp,
                "saturated_pct": self._sat,
                "avg_confidence": self._conf,
                "samples": self._samples,
                "since_sec": max(0.0, time.time() - self._state_since),
            }

    def risk_adjustment(self) -> dict:
        with self._lock:
            return dict(_RISK.get(self._state, _RISK["nominal"]))


if __name__ == "__main__":
    m = QualityMonitor()
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    for _ in range(10):
        m.observe_frame(frame, [], time.time())
    print(m.state())
