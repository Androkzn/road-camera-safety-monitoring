"""Tests for backend.api — feedback routes (unit-level, no live server).

``TestClient`` (from starlette, surfaced via FastAPI) lets us hit routes
synchronously in-process. Under the hood it speaks ASGI directly, so we
skip the uvicorn layer and get deterministic, fast tests.

``patch(...)`` (from unittest.mock) temporarily replaces a target attribute
inside a ``with`` block — useful for rerouting module-level constants like
file paths without modifying the production code.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def feedback_app(_isolate_data_dir):
    """Build a minimal FastAPI app with feedback routes mounted.

    Steps: create a blank app, redirect the feedback module's file-path
    constants to the temp dir, mount the routes, and yield a TestClient
    plus the data directory. The ``with`` block keeps the patches alive
    for the whole test.
    """
    app = FastAPI()

    # ``patch(target, value)`` used as a context manager swaps the named
    # attribute for the duration of the ``with`` block, then reverts it.
    # The chained backslash line-continuations are just formatting.
    with patch("backend.api.feedback._DATA_DIR", _isolate_data_dir), \
         patch("backend.api.feedback._FEEDBACK_PATH", _isolate_data_dir / "feedback.jsonl"), \
         patch("backend.api.feedback._EVENTS_PATH", _isolate_data_dir / "events.json"):
        from backend.api.feedback import mount
        mount(app)
        yield TestClient(app), _isolate_data_dir


class TestFeedbackRoutes:
    """GET/POST /api/feedback and the /api/coaching_queue helper."""

    def test_get_feedback_empty(self, feedback_app):
        """Fresh install returns an empty items list (no crash, no 500)."""
        client, data_dir = feedback_app
        resp = client.get("/api/feedback")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    def test_post_feedback_tp(self, feedback_app):
        """Submitting a ``tp`` verdict persists and is visible via GET."""
        client, data_dir = feedback_app
        events_path = data_dir / "events.json"
        events_path.write_text(json.dumps([{"event_id": "e1", "risk_level": "high"}]))

        resp = client.post("/api/feedback", json={"event_id": "e1", "verdict": "tp"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True

        get_resp = client.get("/api/feedback")
        records = get_resp.json()["items"]
        assert len(records) == 1
        assert records[0]["verdict"] == "tp"

    def test_post_feedback_fp(self, feedback_app):
        """A ``fp`` verdict is accepted with 200 (parallel of the tp path)."""
        client, data_dir = feedback_app
        events_path = data_dir / "events.json"
        events_path.write_text(json.dumps([{"event_id": "e2", "risk_level": "medium"}]))

        resp = client.post("/api/feedback", json={"event_id": "e2", "verdict": "fp"})
        assert resp.status_code == 200

    def test_post_feedback_invalid_verdict(self, feedback_app):
        """Unknown verdict strings are rejected at the validation layer."""
        client, _ = feedback_app
        resp = client.post("/api/feedback", json={"event_id": "e1", "verdict": "wrong"})
        assert resp.status_code in (400, 422)

    def test_coaching_queue(self, feedback_app):
        """The coaching queue lists events eligible for driver review."""
        client, data_dir = feedback_app
        events_path = data_dir / "events.json"
        events_path.write_text(json.dumps([
            {"event_id": "e1", "risk_level": "medium", "event_type": "pedestrian_proximity"},
            {"event_id": "e2", "risk_level": "high", "event_type": "tailgating"},
            {"event_id": "e3", "risk_level": "low", "event_type": "tailgating"},
        ]))
        resp = client.get("/api/coaching_queue")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, dict)
        assert "items" in body or "count" in body or isinstance(body, list)
        items = body.get("items", body) if isinstance(body, dict) else body
        assert isinstance(items, list)
