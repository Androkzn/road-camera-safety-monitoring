"""logging.py — central setup for application log output.

What it does:
    Configures how every `log.info(...)` / `log.error(...)` call across the
    backend gets printed. By default it emits one JSON object per line so
    log-aggregation tools (Datadog, ELK, CloudWatch) can parse it; switch
    to plain human-readable text by setting the env var
    `ROAD_LOG_FORMAT=text`. Log verbosity is controlled by
    `ROAD_LOG_LEVEL` (default `INFO`).

Purpose:
    Gives the whole app one consistent log format so production issues
    can be filtered, searched, and alerted on without each module
    inventing its own formatting.

How it works:
    `setup()` is called once at startup (from `server.py`). It builds a
    Python `logging.StreamHandler` that writes to stdout, attaches either
    the custom `_JSONFormatter` class or a text formatter, and replaces
    any pre-existing handlers on the root logger. A `class` in Python is
    a blueprint — `_JSONFormatter` inherits from the standard library's
    `logging.Formatter` and overrides its `format()` method to produce
    JSON instead of the default string. Chatty third-party loggers
    (uvicorn access logs, ultralytics YOLO) are cranked down to WARNING
    so they don't drown the signal. `get_logger(name)` is a thin wrapper
    other modules import to get a named logger.

Connects to:
    - Backend: `server.py` calls `setup_logging()` at import time; every
      other module calls `get_logger(__name__)` to emit structured logs.
    - UI: none — backend-only (logs go to the server's stdout / log file,
      not the browser).
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime, timezone


class _JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat()
        msg = record.getMessage()
        payload = (
            f'{{"ts":"{ts}","level":"{record.levelname}",'
            f'"logger":"{record.name}","msg":{self._quote(msg)}'
        )
        if record.exc_info and record.exc_info[0] is not None:
            payload += f',"exc":{self._quote(self.formatException(record.exc_info))}'
        payload += "}"
        return payload

    @staticmethod
    def _quote(s: str) -> str:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def setup(level: str | None = None) -> None:
    """Configure root logger. Safe to call multiple times."""
    log_level = (level or os.getenv("ROAD_LOG_LEVEL", "INFO")).upper()
    log_format = os.getenv("ROAD_LOG_FORMAT", "json").lower()

    handler = logging.StreamHandler(sys.stdout)
    if log_format == "text":
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-8s %(name)s  %(message)s")
        )
    else:
        handler.setFormatter(_JSONFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, log_level, logging.INFO))

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("ultralytics").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
