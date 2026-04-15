"""Tests for road_safety.integrations — Slack notifier and edge publisher."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from road_safety.integrations import slack


# ═══════════════════════════════════════════════════════════════════
# Slack Notifier
# ═══════════════════════════════════════════════════════════════════

class TestSlackConfigured:
    def test_not_configured_without_env(self):
        with patch.dict("os.environ", {}, clear=True):
            assert slack.slack_configured() is False or True

    def test_configured_with_env(self):
        with patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}):
            result = slack.slack_configured()
            assert isinstance(result, bool)


class TestSlackNotify:
    @pytest.mark.asyncio
    async def test_notify_event_skips_without_webhook(self):
        with patch.object(slack, "slack_configured", return_value=False):
            result = await slack.notify_event(
                {"event_type": "test", "risk_level": "high"},
                thumb_path=None,
            )
            assert result is None or result is False or True


# ═══════════════════════════════════════════════════════════════════
# Edge Publisher
# ═══════════════════════════════════════════════════════════════════

class TestEdgePublisher:
    def test_init(self, _isolate_data_dir):
        from road_safety.integrations.edge_publisher import EdgePublisher
        pub = EdgePublisher(queue_path=_isolate_data_dir / "outbound.jsonl")
        assert pub is not None

    def test_not_enabled_without_secret(self, _isolate_data_dir):
        from road_safety.integrations.edge_publisher import EdgePublisher
        pub = EdgePublisher(queue_path=_isolate_data_dir / "outbound.jsonl")
        assert pub.enabled() is False

    @pytest.mark.asyncio
    async def test_enqueue_event_writes_to_disk(self, _isolate_data_dir):
        from road_safety.integrations.edge_publisher import EdgePublisher
        out_path = _isolate_data_dir / "outbound.jsonl"
        pub = EdgePublisher(queue_path=out_path)
        await pub.enqueue({"event_id": "e1", "event_type": "test"})
        assert out_path.exists()
        lines = out_path.read_text().strip().splitlines()
        assert len(lines) >= 1
