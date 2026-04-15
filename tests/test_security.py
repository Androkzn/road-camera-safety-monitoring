"""Tests for request guards and sensitive feedback attribution."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from road_safety.security import require_bearer_token


def _guard_app(token: str | None):
    app = FastAPI()

    @app.get("/protected")
    def protected(request: Request):
        require_bearer_token(
            request,
            token,
            realm="admin",
            env_var="ROAD_ADMIN_TOKEN",
        )
        return {"ok": True}

    return app


class TestBearerGuard:
    def test_guard_disabled_without_token(self):
        client = TestClient(_guard_app(None))
        resp = client.get("/protected")
        assert resp.status_code == 503

    def test_guard_rejects_missing_header(self):
        client = TestClient(_guard_app("secret-token"))
        resp = client.get("/protected")
        assert resp.status_code == 401

    def test_guard_rejects_wrong_token(self):
        client = TestClient(_guard_app("secret-token"))
        resp = client.get("/protected", headers={"Authorization": "Bearer wrong"})
        assert resp.status_code == 403

    def test_guard_accepts_valid_token(self):
        client = TestClient(_guard_app("secret-token"))
        resp = client.get("/protected", headers={"Authorization": "Bearer secret-token"})
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


class TestSensitiveFeedback:
    @pytest.mark.asyncio
    async def test_feedback_uses_matched_vehicle_id(self, monkeypatch):
        import road_safety.server as server

        monkeypatch.setattr(server.audit, "log", MagicMock())
        monkeypatch.setattr(server.road_registry, "record_feedback", MagicMock())
        monkeypatch.setattr(
            server.state.drift,
            "compute",
            MagicMock(return_value=SimpleNamespace(alert_triggered=False)),
        )

        await server._on_feedback(
            {"event_id": "evt_1", "verdict": "tp", "note": None},
            {"event_id": "evt_1", "vehicle_id": "vehicle_02"},
        )

        server.road_registry.record_feedback.assert_called_once_with(
            "evt_1",
            "tp",
            "vehicle_02",
        )
