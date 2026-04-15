"""Edge-side event publisher.

Async, append-only JSONL queue + batched HMAC-signed HTTPS delivery to a cloud
receiver. Designed to be imported by server.py without forcing network config:
if FLEET_CLOUD_ENDPOINT or FLEET_CLOUD_HMAC_SECRET is missing, the publisher
silently disables itself (``enabled() -> False``) and ``enqueue`` is a no-op
append for audit only. ``flush_once`` short-circuits.

Threat model: TLS provides confidentiality, HMAC-SHA256 over
``f"{timestamp}.{body}"`` provides integrity + authenticity. A +/- 300 s
timestamp window bounds replay; the cloud side also dedupes on event_id.

This module does NO network I/O at import time. Everything is lazy / async.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("edge_publisher")

# ----- presigned thumb URL (mocked) -------------------------------------------------

# In a real deployment the edge node would either (a) upload the redacted thumb
# to object storage and return a presigned GET URL, or (b) serve it itself over
# a short-lived signed URL. For the demo we do (b): the URL points at the edge
# node's own /thumbnails/{name} endpoint with a ``token`` query param derived
# from HMAC(secret, name|expiry). Cloud fetches lazily.

_THUMB_TTL_SEC = 15 * 60


def _sign_thumb_token(secret: str, name: str, expiry: int) -> str:
    mac = hmac.new(secret.encode(), f"{name}.{expiry}".encode(), hashlib.sha256)
    return mac.hexdigest()[:32]


def build_thumbnail_url(
    edge_base_url: str, secret: str, thumb_path: Path, now: int | None = None
) -> tuple[str, str]:
    """Return (thumbnail_url, thumbnail_sha256)."""
    now = now or int(time.time())
    expiry = now + _THUMB_TTL_SEC
    name = thumb_path.name
    token = _sign_thumb_token(secret, name, expiry)
    url = f"{edge_base_url.rstrip('/')}/thumbnails/{name}?exp={expiry}&token={token}"
    sha = hashlib.sha256(thumb_path.read_bytes()).hexdigest() if thumb_path.exists() else ""
    return url, sha


# ----- publisher --------------------------------------------------------------------


@dataclass
class _BackoffState:
    delay: float = 1.0
    max_delay: float = 60.0

    def next(self) -> float:
        d = self.delay
        self.delay = min(self.delay * 2.0, self.max_delay)
        return d

    def reset(self) -> None:
        self.delay = 1.0


class EdgePublisher:
    def __init__(
        self,
        endpoint_url: str | None = None,
        shared_secret: str | None = None,
        queue_path: Path = Path("data/outbound_queue.jsonl"),
        batch_size: int = 20,
        flush_interval_sec: float = 10.0,
        edge_base_url: str | None = None,
        source_name: str | None = None,
    ) -> None:
        self.endpoint_url = endpoint_url or os.getenv("FLEET_CLOUD_ENDPOINT")
        self.shared_secret = shared_secret or os.getenv("FLEET_CLOUD_HMAC_SECRET")
        self.queue_path = Path(queue_path)
        self.batch_size = batch_size
        self.flush_interval_sec = flush_interval_sec
        self.edge_base_url = edge_base_url or os.getenv(
            "FLEET_EDGE_PUBLIC_URL", "http://localhost:8000"
        )
        self.source_name = source_name or os.getenv("FLEET_EDGE_NODE_ID", "edge_node_01")
        self._lock = asyncio.Lock()
        self._backoff = _BackoffState()
        self.queue_path.parent.mkdir(parents=True, exist_ok=True)
        # touch the queue file so readers don't race
        if not self.queue_path.exists():
            self.queue_path.touch()

    # --------------------------------------------------------------------------------

    def enabled(self) -> bool:
        return bool(self.endpoint_url) and bool(self.shared_secret)

    # --------------------------------------------------------------------------------

    async def enqueue(
        self, event: dict, public_thumbnail_path: Path | None = None
    ) -> None:
        """Non-blocking append to local JSONL queue. Never raises."""
        try:
            record: dict[str, Any] = dict(event)
            if public_thumbnail_path is not None:
                # Stored only for local use; stripped before send.
                record["_thumbnail_path"] = str(public_thumbnail_path)
            line = json.dumps(record, separators=(",", ":"), default=str) + "\n"
            async with self._lock:
                # Small writes; sync fs call under the lock is fine here.
                with self.queue_path.open("a", encoding="utf-8") as f:
                    f.write(line)
        except Exception as exc:  # noqa: BLE001
            logger.warning("edge_publisher.enqueue failed: %s", exc)

    # --------------------------------------------------------------------------------

    def _prepare_outbound(self, record: dict) -> dict:
        """Strip edge-only metadata and attach thumbnail_url if applicable."""
        out = {k: v for k, v in record.items() if not k.startswith("_")}
        thumb = record.get("_thumbnail_path")
        if thumb and self.shared_secret:
            p = Path(thumb)
            try:
                url, sha = build_thumbnail_url(self.edge_base_url, self.shared_secret, p)
                if url:
                    out["thumbnail_url"] = url
                if sha:
                    out["thumbnail_sha256"] = sha
            except Exception as exc:  # noqa: BLE001
                logger.warning("thumb url build failed for %s: %s", thumb, exc)
        return out

    def _sign(self, body: bytes, ts: int) -> str:
        assert self.shared_secret is not None
        msg = f"{ts}.".encode() + body
        mac = hmac.new(self.shared_secret.encode(), msg, hashlib.sha256)
        return "sha256=" + mac.hexdigest()

    # --------------------------------------------------------------------------------

    async def flush_once(self) -> tuple[int, int]:
        """Drain up to ``batch_size`` events and POST as one request.

        Returns ``(sent, queued_remaining)``. On HTTP failure items are kept
        in the queue and an exponential backoff delay is applied before the
        next caller-driven flush.
        """
        if not self.enabled():
            return (0, 0)

        async with self._lock:
            try:
                lines = self.queue_path.read_text(encoding="utf-8").splitlines()
            except FileNotFoundError:
                return (0, 0)

        if not lines:
            return (0, 0)

        batch_raw = lines[: self.batch_size]
        remaining_raw = lines[self.batch_size :]

        events: list[dict] = []
        for raw in batch_raw:
            raw = raw.strip()
            if not raw:
                continue
            try:
                events.append(self._prepare_outbound(json.loads(raw)))
            except json.JSONDecodeError:
                logger.warning("dropping malformed queue line")

        if not events:
            # All lines were junk; still truncate so we don't loop on them.
            async with self._lock:
                self.queue_path.write_text(
                    "\n".join(remaining_raw) + ("\n" if remaining_raw else ""),
                    encoding="utf-8",
                )
            return (0, len(remaining_raw))

        payload = {
            "events": events,
            "source": self.source_name,
            "nonce": secrets.token_hex(8),
        }
        body = json.dumps(payload, separators=(",", ":"), default=str).encode()
        ts = int(time.time())
        headers = {
            "Content-Type": "application/json",
            "X-Fleet-Timestamp": str(ts),
            "X-Fleet-Source": self.source_name,
            "Signature": self._sign(body, ts),
        }

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(self.endpoint_url, content=body, headers=headers)
            if resp.status_code >= 500 or resp.status_code in (408, 429):
                delay = self._backoff.next()
                logger.warning(
                    "cloud ingest %s; backing off %.1fs, keeping %d queued",
                    resp.status_code,
                    delay,
                    len(batch_raw),
                )
                await asyncio.sleep(delay)
                return (0, len(lines))
            if resp.status_code >= 400:
                # 4xx other than the transient codes above: drop the batch to
                # avoid poison-pill loops, but log loudly. In practice this is
                # signature/secret misconfig and should page an operator.
                logger.error(
                    "cloud ingest refused %s: %s; dropping batch of %d",
                    resp.status_code,
                    resp.text[:200],
                    len(events),
                )
                async with self._lock:
                    self.queue_path.write_text(
                        "\n".join(remaining_raw) + ("\n" if remaining_raw else ""),
                        encoding="utf-8",
                    )
                return (0, len(remaining_raw))
        except (httpx.HTTPError, OSError) as exc:
            delay = self._backoff.next()
            logger.warning(
                "cloud ingest transport error %s; backing off %.1fs", exc, delay
            )
            await asyncio.sleep(delay)
            return (0, len(lines))

        # 2xx: truncate queue to the remainder.
        self._backoff.reset()
        async with self._lock:
            self.queue_path.write_text(
                "\n".join(remaining_raw) + ("\n" if remaining_raw else ""),
                encoding="utf-8",
            )
        return (len(events), len(remaining_raw))

    # --------------------------------------------------------------------------------

    async def run_forever(self) -> None:
        """Background task. Flushes every ``flush_interval_sec`` until cancelled."""
        logger.info(
            "edge_publisher.run_forever start (enabled=%s, endpoint=%s, queue=%s)",
            self.enabled(),
            self.endpoint_url,
            self.queue_path,
        )
        while True:
            try:
                await asyncio.sleep(self.flush_interval_sec)
                if not self.enabled():
                    continue
                sent, remaining = await self.flush_once()
                if sent or remaining:
                    logger.info(
                        "edge_publisher flushed sent=%d remaining=%d", sent, remaining
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("edge_publisher loop error: %s", exc)
                await asyncio.sleep(self._backoff.next())
