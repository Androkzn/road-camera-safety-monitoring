"""Structured logging configuration.

Call ``setup()`` once at startup to configure the root logger with
JSON-formatted output suitable for production log aggregators
(ELK, Datadog, CloudWatch).  Falls back to human-readable format
when ``ROAD_LOG_FORMAT=text`` is set.
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
