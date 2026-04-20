"""Tests for security helpers and security-adjacent request hooks."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient

from backend.security import require_bearer_token


def _guard_app(token: str | None):
    app = FastAPI()

    @app.get("/protected")
    def protected(request: Request):
        require_bearer_token(
            request,
            token,
            realm="admin",
            env_var="",
        )
        return {"ok": True}

    return app


def _make_request(path: str, query: str = "", headers: dict[str, str] | None = None) -> Request:
    hdrs = [
        (k.lower().encode("latin-1"), v.encode("latin-1"))
        for k, v in (headers or {}).items()
    ]
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("latin-1"),
        "query_string": query.encode("latin-1"),
        "headers": hdrs,
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
    }
    return Request(scope)

class TestBearerGuard:
    """POC: ``require_bearer_token`` is a no-op — always allows."""

    def test_guard_allows_without_token(self):
        client = TestClient(_guard_app(None))
        resp = client.get("/protected")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

    def test_guard_allows_missing_header(self):
        client = TestClient(_guard_app("secret-token"))
        resp = client.get("/protected")
        assert resp.status_code == 200

    def test_guard_allows_wrong_token(self):
        client = TestClient(_guard_app("secret-token"))
        resp = client.get("/protected", headers={"Authorization": "Bearer wrong"})
        assert resp.status_code == 200

    def test_guard_accepts_valid_token(self):
        client = TestClient(_guard_app("secret-token"))
        resp = client.get("/protected", headers={"Authorization": "Bearer secret-token"})
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


class TestSensitiveFeedback:
    @pytest.mark.asyncio
    async def test_feedback_uses_matched_vehicle_id(self, monkeypatch):
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


class TestPublicThumbnailSigning:
    def test_valid_thumb_request_accepts_when_guard_disabled(self, monkeypatch):
        from backend.security import signing

        monkeypatch.setattr(signing, "PUBLIC_THUMBS_REQUIRE_TOKEN", False)
        req = _make_request("/thumbnails/e_public.jpg")
        assert signing.valid_thumb_request("e_public.jpg", req) is True

    def test_valid_thumb_request_rejects_missing_query_when_enabled(self, monkeypatch):
        from backend.security import signing

        monkeypatch.setattr(signing, "PUBLIC_THUMBS_REQUIRE_TOKEN", True)
        monkeypatch.setattr(signing, "THUMB_SIGNING_SECRET", "thumb-secret")
        req = _make_request("/thumbnails/e_public.jpg")
        assert signing.valid_thumb_request("e_public.jpg", req) is False

    def test_valid_thumb_request_accepts_valid_signature(self, monkeypatch):
        from backend.security import signing

        now = 1_700_000_000
        exp = now + 120
        monkeypatch.setattr(signing, "PUBLIC_THUMBS_REQUIRE_TOKEN", True)
        monkeypatch.setattr(signing, "THUMB_SIGNING_SECRET", "thumb-secret")
        monkeypatch.setattr(signing.time, "time", lambda: now)
        token = signing.thumb_token("e_public.jpg", exp)
        req = _make_request(
            "/thumbnails/e_public.jpg",
            query=f"exp={exp}&token={token}",
        )
        assert signing.valid_thumb_request("e_public.jpg", req) is True

    def test_thumbnail_public_denies_invalid_token(self, monkeypatch, _isolate_data_dir):
        from backend.api.routers import thumbnails as thumbnails_router
        from backend.security import signing

        name = "evt_public.jpg"
        thumbs_dir = _isolate_data_dir / "thumbnails"
        (thumbs_dir / name).write_bytes(b"jpeg")

        monkeypatch.setattr(thumbnails_router, "THUMBS_DIR", thumbs_dir)
        monkeypatch.setattr(signing, "PUBLIC_THUMBS_REQUIRE_TOKEN", True)
        monkeypatch.setattr(signing, "THUMB_SIGNING_SECRET", "thumb-secret")
        monkeypatch.setattr(thumbnails_router.audit, "log", MagicMock())

        req = _make_request(f"/thumbnails/{name}", query="exp=1&token=bad")
        with pytest.raises(HTTPException) as exc:
            thumbnails_router.thumbnail(name, req)

        assert exc.value.status_code == 403
        thumbnails_router.audit.log.assert_called_once()

    def test_thumbnail_public_allows_valid_token(self, monkeypatch, _isolate_data_dir):
        from backend.api.routers import thumbnails as thumbnails_router
        from backend.security import signing

        now = 1_700_000_000
        exp = now + 60
        name = "evt_public.jpg"
        thumbs_dir = _isolate_data_dir / "thumbnails"
        (thumbs_dir / name).write_bytes(b"jpeg")

        monkeypatch.setattr(thumbnails_router, "THUMBS_DIR", thumbs_dir)
        monkeypatch.setattr(signing, "PUBLIC_THUMBS_REQUIRE_TOKEN", True)
        monkeypatch.setattr(signing, "THUMB_SIGNING_SECRET", "thumb-secret")
        monkeypatch.setattr(signing.time, "time", lambda: now)
        token = signing.thumb_token(name, exp)

        req = _make_request(
            f"/thumbnails/{name}",
            query=f"exp={exp}&token={token}",
        )
        resp = thumbnails_router.thumbnail(name, req)
        assert isinstance(resp, FileResponse)
