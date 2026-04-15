"""Live video stream capture: resolves a YouTube live URL to HLS, reads frames in a background thread."""

from __future__ import annotations

import subprocess
import threading
import time
from typing import Callable

import cv2

from road_safety.config import YT_DLP_PATH as YT_DLP  # noqa: E402


def resolve_hls(source: str) -> str:
    """If source is a YouTube URL, resolve to a direct HLS manifest URL. Otherwise return as-is."""
    if "youtube.com" in source or "youtu.be" in source:
        try:
            return subprocess.check_output(
                [YT_DLP, "-g", "-f", "bv", source],
                stderr=subprocess.PIPE,
                timeout=30,
            ).decode().strip()
        except Exception as exc:
            raise RuntimeError(f"Failed to resolve YouTube live URL: {exc}")
    return source


class StreamReader:
    """Background thread that pulls frames from a video source at a target FPS."""

    def __init__(self, source_url: str, target_fps: float = 2.0):
        self.source_url = source_url
        self.target_fps = target_fps
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.started_at: float | None = None
        self.frames_read = 0
        self.frames_processed = 0

    def start(self, on_frame: Callable[[float, object], None]) -> None:
        self.started_at = time.time()
        self._thread = threading.Thread(target=self._loop, args=(on_frame,), daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def uptime_sec(self) -> float:
        return 0.0 if self.started_at is None else time.time() - self.started_at

    def _loop(self, on_frame: Callable[[float, object], None]) -> None:
        cap = cv2.VideoCapture(self.source_url)
        if not cap.isOpened():
            print(f"[stream] failed to open: {self.source_url[:80]}...")
            return

        native_fps = cap.get(cv2.CAP_PROP_FPS) or 25
        step = max(int(native_fps / self.target_fps), 1)
        print(f"[stream] opened  native_fps={native_fps:.1f}  step={step}  target_fps={self.target_fps}")

        i = 0
        consecutive_fail = 0
        while not self._stop.is_set():
            ok, frame = cap.read()
            if not ok:
                consecutive_fail += 1
                if consecutive_fail > 50:
                    print("[stream] too many read failures — stopping")
                    break
                time.sleep(0.1)
                continue
            consecutive_fail = 0
            self.frames_read += 1
            if i % step == 0:
                try:
                    on_frame(time.time(), frame)
                    self.frames_processed += 1
                except Exception as exc:
                    print(f"[stream] on_frame error: {exc}")
            i += 1

        cap.release()
        print("[stream] capture loop ended")
