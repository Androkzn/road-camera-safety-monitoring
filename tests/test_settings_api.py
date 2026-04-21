"""Tests for the Settings Console FastAPI router.

Covers: validation 422 shape, revision 409, apply-rate-limit 429,
ticket exchange + single-use consumption. POC: routes are open (no
bearer checks).
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.settings import (
    MIN_CHANGE_INTERVAL_SEC,
    _last_apply_at,
    mount as mount_settings_routes,
)
from backend.services import settings_db
from backend.settings_store import SettingsStore


@pytest.fixture()
def fresh_store(monkeypatch):
    """Replace the module-level STORE singleton with a fresh instance."""
    new_store = SettingsStore()
    import backend.api.settings as api_mod

    monkeypatch.setattr(api_mod, "STORE", new_store)
    monkeypatch.setattr("backend.settings_store.STORE", new_store)
    yield new_store


@pytest.fixture()
def settings_client(tmp_path, fresh_store, monkeypatch):
    """Build a minimal FastAPI app with the settings router mounted."""
    settings_db._reset_for_tests(tmp_path / "settings.db")
    # Reset the per-actor apply cooldown.
    _last_apply_at.clear()

    app = FastAPI()
    mount_settings_routes(app)
    client = TestClient(app)
    yield client, None
    settings_db._reset_for_tests(None)


def test_open_read_returns_200(settings_client):
    client, _ = settings_client
    r = client.get("/api/settings/effective")
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------
def test_get_schema(settings_client):
    client, _ = settings_client
    r = client.get("/api/settings/schema")
    assert r.status_code == 200
    payload = r.json()
    assert payload["schema_version"] >= 1
    assert any(s["key"] == "CONF_THRESHOLD" for s in payload["settings"])


def test_get_effective(settings_client):
    client, _ = settings_client
    r = client.get("/api/settings/effective")
    assert r.status_code == 200
    payload = r.json()
    assert "values" in payload
    assert "revision_hash" in payload


# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
def test_validate_returns_resolved_diff(settings_client):
    client, _ = settings_client
    r = client.post(
        "/api/settings/validate",
        json={"diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["resolved_diff"]["CONF_THRESHOLD"] == 0.6


def test_validate_returns_422_with_errors(settings_client):
    client, _ = settings_client
    r = client.post(
        "/api/settings/validate",
        json={"diff": {"TTC_HIGH_SEC": 5.0, "TTC_MED_SEC": 1.0}},
    )
    assert r.status_code == 422
    keys = {e["key"] for e in r.json()["errors"]}
    assert "TTC_HIGH_SEC" in keys


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
def test_apply_success_then_reflected_in_effective(settings_client):
    client, _ = settings_client
    r = client.post(
        "/api/settings/apply",
        json={
            "diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65},
            "operator_label": "test",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "CONF_THRESHOLD" in body["applied_now"]
    eff = client.get("/api/settings/effective").json()
    assert eff["values"]["CONF_THRESHOLD"] == 0.6


def test_apply_validation_error_returns_422(settings_client):
    client, _ = settings_client
    r = client.post(
        "/api/settings/apply",
        json={"diff": {"TTC_HIGH_SEC": 99.0}, "operator_label": "test"},
    )
    assert r.status_code == 422


def test_apply_revision_conflict_returns_409(settings_client):
    client, _ = settings_client
    r = client.post(
        "/api/settings/apply",
        json={
            "diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65},
            "expected_revision_hash": "definitely-not-current",
            "operator_label": "test",
        },
    )
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "revision_conflict"


def test_apply_privacy_confirm_required(settings_client):
    client, _ = settings_client
    r = client.post(
        "/api/settings/apply",
        json={"diff": {"ALPR_MODE": "on"}, "operator_label": "test"},
    )
    assert r.status_code == 400
    assert r.json()["error"] == "privacy_confirm_required"
    # With the flag it goes through.
    r2 = client.post(
        "/api/settings/apply",
        json={
            "diff": {"ALPR_MODE": "on"},
            "confirm_privacy_change": True,
            "operator_label": "test2",
        },
    )
    assert r2.status_code == 200


def test_apply_rate_limit_429(settings_client):
    client, _ = settings_client
    actor = "rate-test"
    body = {
        "diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65},
        "operator_label": actor,
    }
    r1 = client.post("/api/settings/apply", json=body)
    assert r1.status_code == 200
    # Immediate second hit is below the cooldown.
    r2 = client.post("/api/settings/apply", json=body)
    assert r2.status_code == 429
    assert "Retry-After" in r2.headers


def test_failed_apply_does_not_burn_cooldown(settings_client):
    """A validation-failing apply must not lock the operator out.

    Regression test for the eager-stamp bug: previously the cooldown was
    stamped at the top of ``apply`` before validation ran, so a typo (e.g.
    ``TTC_HIGH_SEC=99`` violating the relative-ordering rule) would 422
    *and then* 429 every retry for the next 5 seconds — leaving the
    operator unable to fix their own diff.
    """
    client, _ = settings_client
    actor = "fail-then-succeed"
    bad = client.post(
        "/api/settings/apply",
        json={"diff": {"TTC_HIGH_SEC": 99.0}, "operator_label": actor},
    )
    assert bad.status_code == 422
    # Same actor, immediately, with a valid diff: must succeed (not 429).
    good = client.post(
        "/api/settings/apply",
        json={
            "diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65},
            "operator_label": actor,
        },
    )
    assert good.status_code == 200, good.json()


def test_privacy_confirm_two_step_same_actor_succeeds(settings_client):
    """The privacy-confirm two-step is one logical operation; the second
    call from the same actor must not be blocked by the cooldown."""
    client, _ = settings_client
    actor = "privacy-flow"
    r1 = client.post(
        "/api/settings/apply",
        json={"diff": {"ALPR_MODE": "on"}, "operator_label": actor},
    )
    assert r1.status_code == 400
    assert r1.json()["error"] == "privacy_confirm_required"
    r2 = client.post(
        "/api/settings/apply",
        json={
            "diff": {"ALPR_MODE": "on"},
            "confirm_privacy_change": True,
            "operator_label": actor,
        },
    )
    assert r2.status_code == 200, r2.json()


def test_revision_conflict_does_not_burn_cooldown(settings_client):
    """A 409 from ``expected_revision_hash`` mismatch should not stamp
    the cooldown — the operator needs to refetch and retry immediately."""
    client, _ = settings_client
    actor = "etag-flow"
    bad = client.post(
        "/api/settings/apply",
        json={
            "diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65},
            "expected_revision_hash": "stale-hash",
            "operator_label": actor,
        },
    )
    assert bad.status_code == 409
    good = client.post(
        "/api/settings/apply",
        json={
            "diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65},
            "operator_label": actor,
        },
    )
    assert good.status_code == 200, good.json()


def test_observability_counters_exposed(settings_client):
    client, _ = settings_client
    # Trigger one success + one validation_error so counters are non-zero.
    client.post(
        "/api/settings/apply",
        json={
            "diff": {"CONF_THRESHOLD": 0.6, "SLACK_HIGH_MIN_CONFIDENCE": 0.65},
            "operator_label": "obs",
        },
    )
    _last_apply_at.clear()
    client.post(
        "/api/settings/apply",
        json={"diff": {"TTC_HIGH_SEC": 99.0}, "operator_label": "obs2"},
    )
    r = client.get("/api/settings/observability")
    assert r.status_code == 200
    counters = r.json()["counters"]
    assert counters["settings_apply_total_success"] >= 1
    assert counters["settings_apply_total_validation_error"] >= 1
