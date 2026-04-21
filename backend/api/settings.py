"""Settings Console — FastAPI router.

Routes registered by :func:`mount`:

* Reads (POC: open):
    - ``GET  /api/settings/effective``
    - ``GET  /api/settings/schema``
    - ``GET  /api/settings/apply_log``
    - ``GET  /api/settings/observability``
* Writes (POC: open):
    - ``POST /api/settings/validate``
    - ``POST /api/settings/apply``
    - ``POST /api/settings/rollback``
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import settings_spec
from backend.compliance import audit
from backend.services import settings_db
from backend.settings_store import (
    STORE,
    AppliedResult,
    PrivacyConfirmRequired,
    RevisionConflict,
    SettingsValidationError,
)


# ---------------------------------------------------------------------------
# Apply-rate cooldown (per-token / per-IP best-effort)
# ---------------------------------------------------------------------------
MIN_CHANGE_INTERVAL_SEC = 5.0
_last_apply_at: dict[str, float] = {}


# ---------------------------------------------------------------------------
# Pydantic bodies
# ---------------------------------------------------------------------------
class ValidateBody(BaseModel):
    diff: dict[str, Any] = Field(default_factory=dict)


class ApplyBody(BaseModel):
    diff: dict[str, Any] = Field(default_factory=dict)
    expected_revision_hash: str | None = None
    confirm_privacy_change: bool = False
    operator_label: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _actor(request: Request, label: str | None = None) -> str:
    """Best-effort operator label from the request (POC has no user accounts)."""
    if label:
        return label.strip()[:120]
    fwd = request.headers.get("x-operator-label")
    if fwd:
        return fwd.strip()[:120]
    return "operator"


def _validation_response(errors: list[dict]) -> JSONResponse:
    return JSONResponse(status_code=422, content={"errors": errors})


def _conflict_response(expected: str, actual: str) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={"error": "revision_conflict", "expected": expected, "actual": actual},
    )


def _result_payload(result: AppliedResult) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "applied_now": result.applied_now,
        "pending_restart": result.pending_restart,
        "warnings": result.warnings,
        "revision_hash_before": result.revision_hash_before,
        "revision_hash_after": result.revision_hash_after,
        "revision_no": result.revision_no,
    }


def _check_apply_cooldown(actor: str) -> None:
    """Reject if this actor's last *successful* apply was within the cooldown.

    The cooldown clock is stamped by ``_record_apply_attempt`` only when an
    apply actually mutates state. Failed attempts (validation errors,
    revision conflicts, privacy-confirm-required, no-op diffs) deliberately
    do **not** burn the budget — punishing a typo with a 5 s lockout is a
    hostile UX and offers no protection (no state changed, no subscriber
    storm). DoS protection against rapid invalid attempts is left to the
    upstream proxy / WAF, where it belongs.
    """
    now = time.monotonic()
    last = _last_apply_at.get(actor, 0.0)
    if now - last < MIN_CHANGE_INTERVAL_SEC:
        wait = MIN_CHANGE_INTERVAL_SEC - (now - last)
        raise HTTPException(
            status_code=429,
            detail=f"apply rate limited; retry after {wait:.1f}s",
            headers={"Retry-After": str(int(wait) + 1)},
        )


def _record_apply_attempt(actor: str) -> None:
    """Stamp the cooldown clock — call only after a state-changing apply."""
    _last_apply_at[actor] = time.monotonic()


# Back-compat alias so external callers that imported the old eager helper
# still see the previous "check + stamp on attempt" semantics. Internal
# callers use the split pair above instead.
def _enforce_apply_cooldown(actor: str) -> None:
    _check_apply_cooldown(actor)
    _record_apply_attempt(actor)


# ---------------------------------------------------------------------------
# Mount
# ---------------------------------------------------------------------------
def mount(app: FastAPI) -> None:
    """Register every ``/api/settings/*`` route on ``app``."""

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------
    @app.get("/api/settings/schema")
    async def get_schema():
        return settings_spec.schema_payload()

    @app.get("/api/settings/effective")
    async def get_effective():
        snap = dict(STORE.snapshot())
        return {
            "schema_version": settings_spec.SCHEMA_VERSION,
            "values": snap,
            "revision_hash": STORE.revision_hash(),
            "revision_no": STORE.revision_no(),
        }

    @app.get("/api/settings/apply_log")
    async def get_apply_log(limit: int = 50):
        limit = max(1, min(limit, 200))
        return {"items": settings_db.list_apply_log(limit=limit)}

    @app.get("/api/settings/observability")
    async def get_observability():
        return {"counters": dict(STORE.counters), "revision_no": STORE.revision_no()}

    # ------------------------------------------------------------------
    # Writes — settings
    # ------------------------------------------------------------------
    @app.post("/api/settings/validate")
    async def validate(body: ValidateBody):
        snap = dict(STORE.snapshot())
        merged = dict(snap)
        cleaned: dict[str, Any] = {}
        for k, v in body.diff.items():
            if settings_spec.spec_for(k) is None:
                continue
            try:
                cleaned[k] = settings_spec.coerce(k, v)
            except (TypeError, ValueError) as exc:
                return _validation_response([{"key": k, "reason": f"coercion failed: {exc}"}])
        merged.update(cleaned)
        errors = settings_spec.validate(merged)
        if errors:
            return _validation_response(errors)
        buckets = settings_spec.changed_mutability(cleaned)
        return {
            "ok": True,
            "resolved_diff": cleaned,
            "would_apply_now": sorted(buckets.get("hot_apply", []) + buckets.get("warm_reload", [])),
            "would_pending_restart": sorted(buckets.get("restart_required", [])),
        }

    @app.post("/api/settings/apply")
    async def apply(body: ApplyBody, request: Request):
        actor = _actor(request, body.operator_label)
        # Check-only: failed attempts below do not stamp the cooldown clock.
        _check_apply_cooldown(actor)
        try:
            result = STORE.apply_diff(
                body.diff,
                actor=actor,
                expected_revision_hash=body.expected_revision_hash,
                confirm_privacy_change=body.confirm_privacy_change,
            )
        except RevisionConflict as exc:
            settings_db.insert_apply_log(
                actor_label=actor,
                revision_hash_before=exc.actual,
                revision_hash_after=exc.actual,
                result="conflict",
                warnings=[],
                payload={"diff": body.diff, "expected": exc.expected},
            )
            return _conflict_response(exc.expected, exc.actual)
        except PrivacyConfirmRequired as exc:
            return JSONResponse(
                status_code=400,
                content={
                    "error": "privacy_confirm_required",
                    "key": exc.key,
                    "hint": "set confirm_privacy_change=true to acknowledge",
                },
            )
        except SettingsValidationError as exc:
            return _validation_response(exc.errors)

        # Stamp the cooldown clock only when state actually moved. A no-op
        # apply (empty diff, or diff that resolves to the current values)
        # produces no subscriber storm and shouldn't lock the operator out.
        if result.applied_now or result.pending_restart:
            _record_apply_attempt(actor)
        log_id = settings_db.insert_apply_log(
            actor_label=actor,
            revision_hash_before=result.revision_hash_before,
            revision_hash_after=result.revision_hash_after,
            result="success",
            warnings=result.warnings,
            payload={"diff": body.diff, "applied_now": result.applied_now},
        )
        audit.log(
            "settings.apply",
            f"settings:{result.revision_hash_after}",
            actor=actor,
            outcome="success",
            detail={
                "log_id": log_id,
                "applied_now": result.applied_now,
                "pending_restart": result.pending_restart,
                "warnings": result.warnings,
                "note": body.note,
            },
        )
        return _result_payload(result)

    @app.post("/api/settings/rollback")
    async def rollback(request: Request):
        actor = _actor(request)
        # Check-only; stamp the cooldown only if the rollback actually
        # mutated state (a no-op rollback against an unchanged store
        # shouldn't count toward the budget).
        _check_apply_cooldown(actor)
        result = STORE.rollback_to_last_good(actor=actor)
        if result.applied_now or result.pending_restart:
            _record_apply_attempt(actor)
        settings_db.insert_apply_log(
            actor_label=actor,
            revision_hash_before=result.revision_hash_before,
            revision_hash_after=result.revision_hash_after,
            result="rollback",
            warnings=result.warnings,
            payload={"applied_now": result.applied_now},
        )
        audit.log(
            "settings.rollback",
            f"settings:{result.revision_hash_after}",
            actor=actor,
            outcome="success",
            detail={"warnings": result.warnings},
        )
        return _result_payload(result)
