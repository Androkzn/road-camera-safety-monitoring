"""Live video stream capture: resolves a YouTube live URL, reads frames in a background thread."""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
from typing import Callable

import cv2
import numpy as np

from road_safety.config import YT_DLP_PATH as YT_DLP  # noqa: E402


def _find_bin(name: str) -> str | None:
    return shutil.which(name)


def _is_youtube(source: str) -> bool:
    return "youtube.com" in source or "youtu.be" in source


def resolve_hls(source: str) -> str:
    """If source is a YouTube URL, resolve to a direct stream URL. Otherwise return as-is."""
    if not _is_youtube(source):
        return source

    fmt_selectors = [
        "bv[height<=720]",       # video-only ≤720p (preferred)
        "b[height<=720]",        # combined ≤720p
        "best[height<=720]",     # legacy alias
        "b",                     # best combined
    ]
    node = _find_bin("node")

    for fmt in fmt_selectors:
        cmd = [YT_DLP, "-g", "-f", fmt]
        if node:
            cmd += ["--js-runtimes", "node"]
        cmd.append(source)
        try:
            url = subprocess.check_output(
                cmd, stderr=subprocess.PIPE, timeout=30,
            ).decode().strip()
            if url:
                return url
        except Exception:
            continue

    raise RuntimeError("Failed to resolve YouTube live URL: all format selectors exhausted")


class StreamReader:
    """Background thread that pulls frames from a video source at a target FPS."""

    def __init__(self, source_url: str, target_fps: float = 2.0, *, original_source: str = ""):
        self.source_url = source_url
        self.original_source = original_source or source_url
        self.target_fps = target_fps
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._procs: list[subprocess.Popen] = []
        self.started_at: float | None = None
        self.frames_read = 0
        self.frames_processed = 0

    def start(self, on_frame: Callable[[float, object], None]) -> None:
        self.started_at = time.time()
        self._thread = threading.Thread(target=self._loop, args=(on_frame,), daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        for p in self._procs:
            try:
                p.kill()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5)

    def uptime_sec(self) -> float:
        return 0.0 if self.started_at is None else time.time() - self.started_at

    def _loop(self, on_frame: Callable[[float, object], None]) -> None:
        ffmpeg = _find_bin("ffmpeg")
        if _is_youtube(self.original_source) and ffmpeg:
            self._loop_ytdlp_pipe(on_frame, ffmpeg)
        elif ffmpeg and ("manifest.googlevideo.com" in self.source_url or "/dash/" in self.source_url):
            self._loop_ytdlp_pipe(on_frame, ffmpeg)
        else:
            self._loop_opencv(on_frame)

    def _loop_opencv(self, on_frame: Callable[[float, object], None]) -> None:
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

    def _loop_ytdlp_pipe(self, on_frame: Callable[[float, object], None], ffmpeg: str) -> None:
        """Pipe yt-dlp output through ffmpeg to get raw BGR frames for OpenCV."""
        width, height = 640, 360
        fps = max(int(self.target_fps), 1)

        fmt = "bv[height<=720]/b[height<=720]/best[height<=720]/b"
        ytdlp_cmd = [YT_DLP, "-f", fmt, "-o", "-"]
        node = _find_bin("node")
        if node:
            ytdlp_cmd += ["--js-runtimes", "node"]
        ytdlp_cmd.append(self.original_source)

        ffmpeg_cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "warning",
            "-i", "pipe:0",
            "-vf", f"scale={width}:{height},fps={fps}",
            "-pix_fmt", "bgr24",
            "-f", "rawvideo",
            "-an",
            "pipe:1",
        ]

        print(f"[stream] starting yt-dlp | ffmpeg pipe  {width}x{height} @ {fps}fps")

        ytdlp_proc = subprocess.Popen(
            ytdlp_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        ffmpeg_proc = subprocess.Popen(
            ffmpeg_cmd, stdin=ytdlp_proc.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        ytdlp_proc.stdout.close()

        self._procs = [ytdlp_proc, ffmpeg_proc]

        frame_size = width * height * 3
        consecutive_fail = 0

        while not self._stop.is_set():
            raw = ffmpeg_proc.stdout.read(frame_size)
            if len(raw) != frame_size:
                consecutive_fail += 1
                if consecutive_fail > 10:
                    stderr_tail = ""
                    try:
                        stderr_tail = ffmpeg_proc.stderr.read().decode(errors="replace")[-500:]
                    except Exception:
                        pass
                    print(f"[stream] pipe ended — {consecutive_fail} failures. stderr: {stderr_tail}")
                    break
                time.sleep(0.2)
                continue

            consecutive_fail = 0
            frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))
            self.frames_read += 1
            try:
                on_frame(time.time(), frame)
                self.frames_processed += 1
            except Exception as exc:
                print(f"[stream] on_frame error: {exc}")

        for p in self._procs:
            try:
                p.kill()
            except Exception:
                pass
        self._procs = []
        print("[stream] pipe capture loop ended")
