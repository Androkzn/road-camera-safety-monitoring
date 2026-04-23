"""Tests for the templates service.

Covers: CRUD against SQLite, default-template immutability, apply-time
re-validation + spec migration (drop unknown keys, fill missing keys with
current defaults, reject on cross-field violation).
"""

from __future__ import annotations

import pytest

from backend import settings_spec
from backend.services import settings_db, templates as template_svc


@pytest.fixture(autouse=True)
def _reset_db(tmp_path):
    """Re-point the singleton SQLite connection at a fresh per-test file."""
    settings_db._reset_for_tests(tmp_path / "settings.db")
    yield
    settings_db._reset_for_tests(None)


def test_default_template_is_synthetic_and_immutable() -> None:
    """The built-in "defaults" template is always present at index 0 and
    cannot be renamed, edited, or deleted.

    ``system=True`` marks templates shipped with the product (as opposed to
    user-created). Both mutation attempts are expected to raise
    ``PermissionError`` — Python's built-in "operation not permitted"
    exception. ``pytest.raises(X)`` is a context manager (``with ...:``)
    that passes the test only if the block raises exactly ``X``.
    """
    tmpls = template_svc.list_templates()
    assert tmpls[0]["id"] == template_svc.DEFAULT_TEMPLATE_ID
    assert tmpls[0]["system"] is True
    assert tmpls[0]["payload"]["CONF_THRESHOLD"] == settings_spec.spec_for("CONF_THRESHOLD").default

    with pytest.raises(PermissionError):
        template_svc.update_template(template_svc.DEFAULT_TEMPLATE_ID, name="rename")
    with pytest.raises(PermissionError):
        template_svc.soft_delete_template(template_svc.DEFAULT_TEMPLATE_ID)


def test_create_then_update_creates_immutable_revision() -> None:
    """Every ``update_template`` call appends a new revision row rather
    than mutating the prior one.

    This preserves an audit trail: you can always see what the template
    looked like when it was applied at a given time. The test verifies
    revision 0 is untouched after writing revision 1.
    """
    tmpl = template_svc.create_template(
        name="conservative",
        description="tighter thresholds",
        payload={"CONF_THRESHOLD": 0.65, "SLACK_HIGH_MIN_CONFIDENCE": 0.7},
        actor_label="op",
    )
    revs = template_svc.list_revisions(tmpl["id"])
    assert len(revs) == 1
    assert revs[0]["payload"]["CONF_THRESHOLD"] == 0.65

    template_svc.update_template(tmpl["id"], payload={"CONF_THRESHOLD": 0.7})
    revs = template_svc.list_revisions(tmpl["id"])
    assert len(revs) == 2
    assert revs[1]["payload"]["CONF_THRESHOLD"] == 0.7
    # Revision 1 is unchanged.
    assert revs[0]["payload"]["CONF_THRESHOLD"] == 0.65


def test_soft_delete_hides_from_list() -> None:
    """Deleting a template removes it from ``list_templates`` but keeps the
    row in the DB (soft delete) so existing audit entries that reference
    its id still resolve to something meaningful.
    """
    tmpl = template_svc.create_template(
        name="ephemeral", description="", payload={}, actor_label="op"
    )
    assert template_svc.soft_delete_template(tmpl["id"]) is True
    visible_ids = [t["id"] for t in template_svc.list_templates()]
    assert tmpl["id"] not in visible_ids


def test_apply_drops_unknown_keys_and_fills_missing() -> None:
    """Applying a stored template must migrate it to the current spec:
    drop keys that no longer exist and fill in defaults for new keys.

    Templates are durable artefacts — a template saved six months ago may
    reference retired settings. This test creates one with ``RETIRED_KEY``
    and verifies the plan drops it and fills in every spec key the payload
    omits. ``sorted(...)`` is used because ``plan.filled_keys`` is a list
    with deterministic ordering; comparing sets would also work.
    """
    # CONF_THRESHOLD=0.4 keeps the cross-field rule
    # (SLACK_HIGH_MIN_CONFIDENCE >= CONF_THRESHOLD) satisfied with the
    # spec default for the Slack key.
    tmpl = template_svc.create_template(
        name="with-old-key",
        description="",
        payload={"RETIRED_KEY": 99, "CONF_THRESHOLD": 0.4},
        actor_label="op",
    )
    plan = template_svc.prepare_template_apply(
        tmpl["id"], current_snapshot=settings_spec.defaults()
    )
    assert "RETIRED_KEY" in plan.dropped_keys
    # Every spec key absent from the stored payload should be filled.
    spec_keys = set(settings_spec.all_keys())
    stored_keys = {"CONF_THRESHOLD"}
    expected_filled = sorted(spec_keys - stored_keys)
    assert plan.filled_keys == expected_filled
    assert plan.validation_errors == []


def test_apply_rejects_cross_field_violation() -> None:
    """``TTC_MED_SEC`` must be greater than ``TTC_HIGH_SEC`` (the medium
    risk threshold has to be higher/longer than the high-risk threshold).

    When a template violates that invariant, ``prepare_template_apply``
    surfaces a validation error keyed by the offending field. The set
    comprehension ``{e["key"] for e in ...}`` collects the error keys
    into a set for easy membership testing.
    """
    tmpl = template_svc.create_template(
        name="broken",
        description="",
        payload={"TTC_HIGH_SEC": 1.5, "TTC_MED_SEC": 0.5},
        actor_label="op",
    )
    plan = template_svc.prepare_template_apply(
        tmpl["id"], current_snapshot=settings_spec.defaults()
    )
    keys = {e["key"] for e in plan.validation_errors}
    assert "TTC_MED_SEC" in keys


def test_payload_coercion_repairs_string_floats() -> None:
    """If a stored payload contains numeric values encoded as strings
    (``"0.55"`` instead of ``0.55``), the apply step coerces them to
    floats rather than failing type validation.

    This is defence-in-depth against older clients that round-tripped
    values through an untyped JSON field and lost the numeric type along
    the way.
    """
    tmpl = template_svc.create_template(
        name="stringy",
        description="",
        payload={"CONF_THRESHOLD": "0.55", "SLACK_HIGH_MIN_CONFIDENCE": "0.6"},
        actor_label="op",
    )
    plan = template_svc.prepare_template_apply(
        tmpl["id"], current_snapshot=settings_spec.defaults()
    )
    assert plan.cleaned_diff.get("CONF_THRESHOLD") == 0.55
    assert plan.validation_errors == []
