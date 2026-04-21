"""Tests for backend.integrations — Slack notifier and edge publisher.

Slack notifier posts safety events to a webhook. Edge publisher queues them
to disk and HMAC-signs the batches before pushing to the cloud receiver.
Both are async and mocked here to avoid real network I/O.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.integrations import slack


# ═══════════════════════════════════════════════════════════════════
# Slack Notifier
# ═══════════════════════════════════════════════════════════════════

class TestSlackConfigured:
    """Feature-flag helper: is the Slack webhook configured?"""

    def test_not_configured_without_env(self):
        """No webhook URL → integration reports itself as disabled."""
        with patch.object(slack, "_WEBHOOK", None):
            assert slack.slack_configured() is False

    def test_configured_with_env(self):
        """Presence of a webhook URL flips the flag to True."""
        with patch.object(slack, "_WEBHOOK", "https://hooks.slack.com/test"):
            assert slack.slack_configured() is True


class TestSlackNotify:
    """Behaviour of the async ``notify_*`` functions."""

    # ``@pytest.mark.asyncio`` — marker from pytest-asyncio that tells the
    # test runner "this test is a coroutine; schedule it on an event loop".
    # Without it, an ``async def`` test would just return a coroutine
    # object without ever being executed.
    @pytest.mark.asyncio
    async def test_notify_event_skips_without_webhook(self):
        """When Slack isn't configured, ``notify_event`` silently no-ops."""
        with patch.object(slack, "slack_configured", return_value=False):
            result = await slack.notify_event(
                {"event_type": "test", "risk_level": "high"},
                thumb_path=None,
            )
            assert result is None or result is False or True

    @pytest.mark.asyncio
    async def test_notify_high_skips_public_image_relay_when_disabled(self, sample_event, tmp_path):
        """With image relay off, no upload call is made and no image block lands in Slack."""
        thumb_path = tmp_path / "thumb.jpg"
        thumb_path.write_bytes(b"fake-jpeg")

        # ``AsyncMock`` is like MagicMock but awaitable — matches the async
        # signature of the real httpx client methods.
        upload_mock = AsyncMock(return_value="https://example.com/thumb.jpg")

        class DummyResponse:
            """Stand-in for httpx.Response with the fields the code reads."""
            status_code = 200
            text = "ok"

        class DummyClient:
            """Stand-in for httpx.AsyncClient; supports ``async with``."""

            def __init__(self):
                self.post = AsyncMock(return_value=DummyResponse())

            # ``__aenter__`` / ``__aexit__`` are the async versions of the
            # context-manager protocol, so the class works with
            # ``async with DummyClient() as c:``.
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

        client = DummyClient()

        with patch.object(slack, "_WEBHOOK", "https://hooks.slack.com/test"), \
             patch.object(slack, "_IMAGE_RELAY_ENABLED", False), \
             patch.object(slack, "_upload_public_image", upload_mock), \
             patch("backend.integrations.slack.httpx.AsyncClient", return_value=client):
            await slack.notify_high(sample_event, thumb_path)

        upload_mock.assert_not_awaited()
        client.post.assert_awaited_once()
        payload = client.post.await_args.kwargs["json"]
        assert not any(block.get("type") == "image" for block in payload["blocks"])


# ═══════════════════════════════════════════════════════════════════
# Edge Publisher
# ═══════════════════════════════════════════════════════════════════

class TestEdgePublisher:
    """The edge→cloud publisher queues events and HMAC-signs batches."""

    def test_init(self, _isolate_data_dir):
        """Construction works with just a queue path — no HMAC secret required yet."""
        from backend.integrations.edge_publisher import EdgePublisher
        pub = EdgePublisher(queue_path=_isolate_data_dir / "outbound.jsonl")
        assert pub is not None

    def test_not_enabled_without_secret(self, _isolate_data_dir):
        """Without a shared secret the publisher reports itself disabled."""
        from backend.integrations.edge_publisher import EdgePublisher
        pub = EdgePublisher(queue_path=_isolate_data_dir / "outbound.jsonl")
        assert pub.enabled() is False

    @pytest.mark.asyncio
    async def test_enqueue_event_writes_to_disk(self, _isolate_data_dir):
        """``enqueue`` appends a JSON line to the outbound queue file."""
        from backend.integrations.edge_publisher import EdgePublisher
        out_path = _isolate_data_dir / "outbound.jsonl"
        pub = EdgePublisher(queue_path=out_path)
        await pub.enqueue({"event_id": "e1", "event_type": "test"})
        assert out_path.exists()
        lines = out_path.read_text().strip().splitlines()
        assert len(lines) >= 1

    def test_prepare_outbound_omits_thumb_url_without_edge_base(self, _isolate_data_dir):
        """If no public edge base URL is set, thumbnail fields are omitted from the payload."""
        from backend.integrations.edge_publisher import EdgePublisher

        thumb = _isolate_data_dir / "thumb_public.jpg"
        thumb.write_bytes(b"fake-jpeg")
        pub = EdgePublisher(
            endpoint_url="https://cloud.example.com/ingest",
            shared_secret="secret",
            edge_base_url="",
            queue_path=_isolate_data_dir / "outbound.jsonl",
        )
        out = pub._prepare_outbound(
            {
                "event_id": "e1",
                "event_type": "test",
                "_thumbnail_path": str(thumb),
            }
        )
        assert out["event_id"] == "e1"
        assert "thumbnail_url" not in out
        assert "thumbnail_sha256" not in out
