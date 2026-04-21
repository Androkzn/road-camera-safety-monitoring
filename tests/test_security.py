"""Network-level guards and security-adjacent request hooks.

POC: the app has no user authentication. The only network-level guards
remaining are SSRF rejection of private-IP stream URLs and the per-IP clip
rate-limiter. Tests in this module cover non-auth behaviours that live
near the edge of the request/response path.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


class TestSensitiveFeedback:
    """Verify that operator feedback is attributed to the correct vehicle.

    The regression being guarded against: emitting feedback under the wrong
    vehicle_id would taint the wrong driver's safety score. This test pins
    down that the event-dict's vehicle_id is what gets recorded.
    """

    @pytest.mark.asyncio
    async def test_feedback_uses_matched_vehicle_id(self, monkeypatch):
        """Feedback submitted for an event routes to that event's vehicle_id, not a stale default.

        ``monkeypatch.setattr(target, val)`` replaces an attribute for the
        test's lifetime and auto-restores on teardown. Used here to stub out
        audit logging and drift computation so we only test attribution.
        """
        from backend.perception import emit as emit_module

        monkeypatch.setattr(emit_module.audit, "log", MagicMock())
        monkeypatch.setattr(emit_module.road_registry, "record_feedback", MagicMock())
        monkeypatch.setattr(
            emit_module.state.drift,
            "compute",
            MagicMock(return_value=SimpleNamespace(alert_triggered=False)),
        )

        await emit_module.on_feedback(
            {"event_id": "evt_1", "verdict": "tp", "note": None},
            {"event_id": "evt_1", "vehicle_id": "vehicle_02"},
        )

        emit_module.road_registry.record_feedback.assert_called_once_with(
            "evt_1",
            "tp",
            "vehicle_02",
        )
