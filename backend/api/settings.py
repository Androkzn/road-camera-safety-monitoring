"""Settings Console — FastAPI router.

Routes registered by :func:`mount`:

* Reads (POC: open):
    - ``GET  /api/settings/effective``
    - ``GET  /api/settings/schema``
    - ``GET  /api/settings/templates``
    - ``GET  /api/settings/templates/{template_id}/revisions``
    - ``GET  /api/settings/baseline?audit_id=…``
    - ``GET  /api/settings/impact?audit_id=…``
    - ``GET  /api/settings/impact/history``
    - ``GET  /api/settings/apply_log``
    - ``GET  /api/settings/observability``
* Writes (POC: open):
    - ``POST /api/settings/validate``
    - ``POST /api/settings/apply``
    - ``POST /api/settings/rollback``
    - ``POST /api/settings/templates``
    - ``PATCH /api/settings/templates/{template_id}``
    - ``DELETE /api/settings/templates/{template_id}``
    - ``POST /api/settings/templates/{template_id}/apply``
    - ``POST /api/settings/baseline/capture``
    - ``POST /api/settings/stream_ticket``
* SSE (ticket-gated):
    - ``GET  /api/settings/impact/stream?ticket=…``

UI connection
-------------
Page: SettingsPage — [file](frontend/src/features/settings/SettingsPage.tsx)
UI element: powers the entire Settings Console page — the tunables column
on the left (sliders / toggles), the Apply / Rollback buttons at the
bottom, and the live impact card on the right that streams updates over
SSE after each apply.
Backend route(s): GET /api/settings/effective, GET /api/settings/schema,
GET /api/settings/templates, GET /api/settings/templates/{template_id}/revisions,
GET /api/settings/baseline, GET /api/settings/impact,
GET /api/settings/impact/history, GET /api/settings/apply_log,
GET /api/settings/observability, POST /api/settings/validate,
POST /api/settings/apply, POST /api/settings/rollback,
POST /api/settings/templates, PATCH /api/settings/templates/{template_id},
DELETE /api/settings/templates/{template_id},
POST /api/settings/templates/{template_id}/apply,
POST /api/settings/baseline/capture, POST /api/settings/stream_ticket,
GET /api/settings/impact/stream.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from backend import settings_spec
from backend.compliance import audit
from backend.services import settings_db
from backend.services import templates as template_svc
from backend.services.impact import ImpactMonitor
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
# Minimum wall-clock gap between two *successful* applies by the same actor.
# Guards against subscriber storms on the impact SSE when an operator
# mashes the Apply button. Not a security boundary — actual DoS protection
# belongs upstream at the proxy/WAF.
MIN_CHANGE_INTERVAL_SEC = 5.0
# Keyed by actor label (from x-operator-label header or explicit body
# field). Stores the monotonic-clock timestamp of the last *mutating* apply.
_last_apply_at: dict[str, float] = {}


# ---------------------------------------------------------------------------
# Ticket exchange (single-use, 30 s TTL)
# ---------------------------------------------------------------------------
# SSE connections can't carry an Authorization header from EventSource, so
# we use a short-lived capability-style ticket: the client POSTs
# /api/settings/stream_ticket, gets a one-shot token, then connects to
# /api/settings/impact/stream?ticket=... The ticket is consumed on first
# use and auto-expires after TTL.
_TICKET_TTL_SEC = 30.0
# ticket -> (actor, monotonic-expiry-time)
_tickets: dict[str, tuple[str, float]] = {}  # ticket -> (actor, exp)
# Guards the dict against the async fan-in on issue+consume+sweep. Using
# asyncio.Lock (not threading.Lock) because all access happens on the
# event loop.
_ticket_lock = asyncio.Lock()


async def _issue_ticket(actor: str) -> tuple[str, float]:
    """Mint and store a fresh ticket. Sweeps expired entries opportunistically."""
    async with _ticket_lock:
        now = time.monotonic()
        # Janitor sweep — cheap because the dict is tiny.
        for k in [t for t, (_a, exp) in _tickets.items() if exp <= now]:
            _tickets.pop(k, None)
        ticket = secrets.token_hex(16)
        _tickets[ticket] = (actor, now + _TICKET_TTL_SEC)
        return ticket, _TICKET_TTL_SEC


async def _consume_ticket(ticket: str) -> str | None:
    """Pop a ticket if valid. Returns the actor label or ``None``."""
    async with _ticket_lock:
        item = _tickets.pop(ticket, None)
        if item is None:
            return None
        actor, exp = item
        if time.monotonic() > exp:
            return None
        return actor


# ---------------------------------------------------------------------------
# Pydantic bodies
# ---------------------------------------------------------------------------
# These bodies are request-only, not part of the SSE/REST wire contract
# the FE consumes via generated types — they stay local to this module
# (not in backend/api/models.py) because the Settings Console FE builds
# the request shapes from the schema spec, not from a pydantic-generated
# TS type.
class ValidateBody(BaseModel):
    """Request body for POST /api/settings/validate.

    ``diff`` is a sparse map of ``{setting_key: new_value}``. Keys the
    caller leaves out keep their current value. Consumed by the
    ``useSettings`` hook's debounced preview-validate path.
    """

    diff: dict[str, Any] = Field(default_factory=dict)


class ApplyBody(BaseModel):
    """Request body for POST /api/settings/apply.

    - ``expected_revision_hash`` drives optimistic concurrency: the
      server rejects with 409 when another operator applied since the
      client last read. Posted by ``useSettingsApply``.
    - ``confirm_privacy_change`` must be ``true`` before the store will
      let a privacy-sensitive toggle flip (e.g. PII redaction off).
    - ``operator_label`` / ``note`` are recorded on the audit trail.
    """

    diff: dict[str, Any] = Field(default_factory=dict)
    expected_revision_hash: str | None = None
    confirm_privacy_change: bool = False
    operator_label: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


class TemplateCreateBody(BaseModel):
    """Request body for POST /api/settings/templates.

    ``payload`` is a map of setting-key overrides stored on the template.
    """

    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    payload: dict[str, Any] = Field(default_factory=dict)


class TemplateUpdateBody(BaseModel):
    """Request body for PATCH /api/settings/templates/{template_id}.

    All fields optional — omit a field to leave it unchanged.
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    payload: dict[str, Any] | None = None


class TemplateApplyBody(BaseModel):
    """Request body for POST /api/settings/templates/{template_id}/apply.

    Same optimistic-concurrency + privacy-confirm semantics as
    :class:`ApplyBody`, but the diff is computed server-side from the
    template payload.
    """

    expected_revision_hash: str | None = None
    confirm_privacy_change: bool = False
    operator_label: str | None = Field(default=None, max_length=120)


class StreamTicketBody(BaseModel):
    """Request body for POST /api/settings/stream_ticket.

    The SSE endpoint consumes the returned ticket; see the
    ``_issue_ticket`` / ``_consume_ticket`` helpers.
    """

    operator_label: str | None = Field(default=None, max_length=120)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _actor(request: Request, label: str | None = None) -> str:
    """Best-effort operator label from the request (POC has no user accounts).

    Precedence: explicit body field > ``x-operator-label`` request header >
    generic fallback ``"operator"``. Trimmed and length-capped to 120
    chars so a pathological value can't bloat audit records. Used as the
    cooldown key and the audit-log ``actor`` field.
    """
    if label:
        return label.strip()[:120]
    fwd = request.headers.get("x-operator-label")
    if fwd:
        return fwd.strip()[:120]
    return "operator"


def _validation_response(errors: list[dict]) -> JSONResponse:
    """Uniform 422 payload for schema / spec validation failures.

    FE (``useSettingsApply``) keys off the ``errors`` array to flag
    specific rows in the settings form, so the shape must stay stable.
    """
    return JSONResponse(status_code=422, content={"errors": errors})


def _conflict_response(expected: str, actual: str) -> JSONResponse:
    """Uniform 409 payload for optimistic-concurrency conflicts.

    Emitted when the client's ``expected_revision_hash`` no longer
    matches the store — i.e. someone else applied in the meantime. FE
    prompts the operator to refresh before retrying.
    """
    return JSONResponse(
        status_code=409,
        content={"error": "revision_conflict", "expected": expected, "actual": actual},
    )


def _result_payload(result: AppliedResult) -> dict[str, Any]:
    """Flatten an ``AppliedResult`` into the shape the FE expects.

    Mirrored by the TS ``ApplyResultPayload`` type in
    ``frontend/src/features/settings/types.ts``. Any field added here
    must be added there too.
    """
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
    """Legacy helper: check the cooldown AND immediately stamp it.

    Kept only for external importers that used the pre-split API. New
    call sites should use ``_check_apply_cooldown`` early and
    ``_record_apply_attempt`` only after a state-changing apply.
    """
    _check_apply_cooldown(actor)
    _record_apply_attempt(actor)


# ---------------------------------------------------------------------------
# Mount
# ---------------------------------------------------------------------------
def mount(
    app: FastAPI,
    *,
    impact_monitor: ImpactMonitor,
    impact_subscribers: list[asyncio.Queue],
) -> None:
    """Register every ``/api/settings/*`` route on ``app``.

    ``impact_subscribers`` is a list of asyncio Queues filled by ``server.py``
    when an apply happens; the SSE handler drains its own queue and closes
    on disconnect. Keeping the list owned by the server keeps the lifecycle
    consistent with the existing ``/stream/events`` SSE pattern.
    """

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------
    @app.get("/api/settings/schema")
    async def get_schema():
        """Return the settings spec (every tunable + its metadata).

        The FE (``useSettings``) uses this to render the form: widget
        type, range, label, description, mutability bucket (hot / warm /
        restart-required), and privacy flag all come from here.
        """
        return settings_spec.schema_payload()

    @app.get("/api/settings/effective")
    async def get_effective():
        """Return the live effective values + current revision stamp.

        ``revision_hash`` is the FE's optimistic-concurrency token — it
        sends it back in the next ``ApplyBody.expected_revision_hash``.
        """
        snap = dict(STORE.snapshot())
        return {
            "schema_version": settings_spec.SCHEMA_VERSION,
            "values": snap,
            "revision_hash": STORE.revision_hash(),
            "revision_no": STORE.revision_no(),
        }

    @app.get("/api/settings/templates")
    async def get_templates():
        """List non-deleted templates. Drives the Templates drawer UI."""
        return {"templates": template_svc.list_templates()}

    @app.get("/api/settings/templates/{template_id}/revisions")
    async def get_template_revisions(template_id: str):
        """Return the revision history for a single template.

        Returns 404 when the id is unknown rather than an empty list, so
        the FE can distinguish "template exists with no revisions" from
        "wrong template id".
        """
        if template_svc.get_template(template_id) is None:
            raise HTTPException(status_code=404, detail=f"template {template_id} not found")
        return {"revisions": template_svc.list_revisions(template_id)}

    @app.get("/api/settings/baseline")
    async def get_baseline(audit_id: str = Query(...)):
        """Return the before-snapshot captured at the time of ``audit_id``.

        Used by the Impact card to diff "what the system looked like
        BEFORE the change" vs the current state.
        """
        bl = settings_db.baseline_for_audit(audit_id)
        if bl is None:
            raise HTTPException(status_code=404, detail="no baseline for that audit_id")
        return bl

    @app.get("/api/settings/impact")
    async def get_impact(audit_id: str | None = None):
        """Return the live impact report for a given apply session.

        Without ``audit_id`` the caller gets the *current* active session
        (the most recent apply, still accumulating samples). With
        ``audit_id`` the caller gets the historical archived session for
        that apply. Consumed by the ``useImpact`` hook that drives the
        ImpactCard on the SettingsPage.
        """
        report = (
            impact_monitor.report_for(audit_id)
            if audit_id
            else impact_monitor.current_report()
        )
        if report is None:
            return {"report": None}
        return {"report": report.to_dict()}

    @app.get("/api/settings/impact/history")
    async def get_impact_history(limit: int = 20):
        """Return the last ``limit`` archived impact sessions (default 20, max 200)."""
        limit = max(1, min(limit, 200))
        return {"items": settings_db.list_archived_sessions(limit=limit)}

    @app.get("/api/settings/apply_log")
    async def get_apply_log(limit: int = 50):
        """Return the last ``limit`` apply-log rows (default 50, max 200).

        Each row captures actor, revision-hash-before/after, result
        (success / conflict / rollback / template_apply), warnings, and
        the diff payload. Drives the Apply-log drawer.
        """
        limit = max(1, min(limit, 200))
        return {"items": settings_db.list_apply_log(limit=limit)}

    @app.get("/api/settings/observability")
    async def get_observability():
        """Return internal store counters + current revision number.

        Operator-only diagnostics; not part of the primary FE surface.
        """
        return {"counters": dict(STORE.counters), "revision_no": STORE.revision_no()}

    # ------------------------------------------------------------------
    # Writes — settings
    # ------------------------------------------------------------------
    @app.post("/api/settings/validate")
    async def validate(body: ValidateBody):
        """Dry-run a diff: coerce + validate WITHOUT mutating state.

        Returns the fully-coerced diff and a prediction of which keys
        would apply immediately vs pend a restart. The FE calls this on
        every form change (debounced) to drive inline error styling on
        the inputs.

        - Keys not in the spec are silently dropped (forward-compat with
          a FE that knows about a key the BE does not).
        - A coercion failure short-circuits with a single-key error so
          the caller isn't flooded with downstream validation errors
          that were really just a type mismatch.
        """
        snap = dict(STORE.snapshot())
        merged = dict(snap)
        cleaned: dict[str, Any] = {}
        for k, v in body.diff.items():
            # Silently drop unknown keys — forward-compat guard.
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
        # Bucket each changed key into its mutability class so the FE
        # can preview "these will apply instantly / these need a
        # restart" before the operator clicks Apply.
        buckets = settings_spec.changed_mutability(cleaned)
        return {
            "ok": True,
            "resolved_diff": cleaned,
            "would_apply_now": sorted(buckets.get("hot_apply", []) + buckets.get("warm_reload", [])),
            "would_pending_restart": sorted(buckets.get("restart_required", [])),
        }

    @app.post("/api/settings/apply")
    async def apply(body: ApplyBody, request: Request):
        """Commit a settings diff: validate, persist, audit, broadcast.

        Drives the ``useSettingsApply`` hook on the SettingsPage. Walks
        through, in order:

        1. Rate-limit check (actor-scoped, 5 s between applies).
        2. ``STORE.apply_diff`` — pydantic-style validation + optimistic
           concurrency + privacy-confirm gating. Translates domain
           exceptions into the standard 409 / 400 / 422 responses.
        3. Impact-monitor session open (``on_settings_change``) so the
           ImpactCard can start collecting samples.
        4. Cooldown stamp — ONLY on a real state change. No-op applies
           don't lock out the operator.
        5. Apply-log row + immutable audit entry.
        6. SSE broadcast to connected ImpactCards so they repaint the
           moment the apply lands, instead of waiting for the next poll.
        """
        actor = _actor(request, body.operator_label)
        # Check-only: failed attempts below do not stamp the cooldown clock.
        _check_apply_cooldown(actor)
        before_snap = dict(STORE.snapshot())
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

        after_snap = dict(STORE.snapshot())
        changed_keys = sorted(body.diff.keys())
        audit_id: str | None = None
        if changed_keys and result.applied_now:
            audit_id = impact_monitor.on_settings_change(
                before_snap, after_snap, actor_label=actor, changed_keys=changed_keys
            )
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
            audit_id=audit_id,
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
                "audit_id": audit_id,
                "note": body.note,
            },
        )
        # Best-effort SSE notification.
        payload = _result_payload(result)
        payload["audit_id"] = audit_id
        await _broadcast(impact_subscribers, {"event": "apply", "data": payload})
        return payload

    @app.post("/api/settings/rollback")
    async def rollback(request: Request):
        """Restore the most recent "last known good" snapshot.

        Same cooldown + impact-monitor lifecycle as apply, but instead
        of taking a caller-supplied diff the store computes one that
        reverts to the last successful prior revision. Invoked from the
        SettingsPage's Rollback button when an apply regresses the
        system.
        """
        actor = _actor(request)
        # Check-only; stamp the cooldown only if the rollback actually
        # mutated state (a no-op rollback against an unchanged store
        # shouldn't count toward the budget).
        _check_apply_cooldown(actor)
        before = dict(STORE.snapshot())
        result = STORE.rollback_to_last_good(actor=actor)
        after = dict(STORE.snapshot())
        if result.applied_now or result.pending_restart:
            impact_monitor.archive_active()
            audit_id = impact_monitor.on_settings_change(
                before, after, actor_label=actor, changed_keys=sorted(after.keys())
            )
            _record_apply_attempt(actor)
        else:
            audit_id = None
        settings_db.insert_apply_log(
            actor_label=actor,
            revision_hash_before=result.revision_hash_before,
            revision_hash_after=result.revision_hash_after,
            result="rollback",
            warnings=result.warnings,
            payload={"applied_now": result.applied_now},
            audit_id=audit_id,
        )
        audit.log(
            "settings.rollback",
            f"settings:{result.revision_hash_after}",
            actor=actor,
            outcome="success",
            detail={"warnings": result.warnings, "audit_id": audit_id},
        )
        payload = _result_payload(result)
        payload["audit_id"] = audit_id
        return payload

    # ------------------------------------------------------------------
    # Writes — templates
    # ------------------------------------------------------------------
    @app.post("/api/settings/templates")
    async def create_template(body: TemplateCreateBody, request: Request):
        """Create a new reusable settings template.

        Audit-logged. 400 on duplicate names (bubbled from the service
        layer via ``ValueError``).
        """
        actor = _actor(request)
        try:
            tmpl = template_svc.create_template(
                name=body.name,
                description=body.description,
                payload=body.payload,
                actor_label=actor,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit.log(
            "settings.template.create",
            f"template:{tmpl['id']}",
            actor=actor,
            outcome="success",
            detail={"name": tmpl["name"]},
        )
        return tmpl

    @app.patch("/api/settings/templates/{template_id}")
    async def update_template(template_id: str, body: TemplateUpdateBody, request: Request):
        """Update template metadata and/or payload.

        Omitted body fields are left unchanged. 404 on unknown id, 409
        when the template is locked (e.g. built-in and immutable).
        """
        actor = _actor(request)
        try:
            tmpl = template_svc.update_template(
                template_id,
                name=body.name,
                description=body.description,
                payload=body.payload,
                actor_label=actor,
            )
        except KeyError:
            raise HTTPException(status_code=404, detail=f"template {template_id} not found")
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit.log(
            "settings.template.update",
            f"template:{template_id}",
            actor=actor,
            outcome="success",
            detail={"changed_payload": body.payload is not None},
        )
        return tmpl

    @app.delete("/api/settings/templates/{template_id}")
    async def delete_template(template_id: str, request: Request):
        """Soft-delete a template (tombstoned, retains history).

        Returns ``{"ok": True, "deleted": bool}`` where ``deleted`` is
        False if the template was already tombstoned — idempotent.
        """
        actor = _actor(request)
        try:
            modified = template_svc.soft_delete_template(template_id)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"template {template_id} not found")
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit.log(
            "settings.template.delete",
            f"template:{template_id}",
            actor=actor,
            outcome="success",
            detail={"already_deleted": not modified},
        )
        return {"ok": True, "deleted": modified}

    @app.post("/api/settings/templates/{template_id}/apply")
    async def apply_template(template_id: str, body: TemplateApplyBody, request: Request):
        """Apply a template's payload as a settings diff.

        Same pipeline as the ordinary ``/apply`` — including cooldown,
        impact-monitor session, apply log, and audit — but the diff
        comes from the template after reconciliation against the
        current snapshot (keys already matching are dropped so they
        don't show up as a "change" in the audit detail).
        """
        actor = _actor(request, body.operator_label)
        # Check-only; the cooldown clock is stamped only after a real
        # state change below (so a missing template, validation failure,
        # privacy-confirm-required, or revision conflict don't lock the
        # operator out of fixing the request).
        _check_apply_cooldown(actor)
        try:
            plan = template_svc.prepare_template_apply(
                template_id, current_snapshot=dict(STORE.snapshot())
            )
        except KeyError:
            raise HTTPException(status_code=404, detail=f"template {template_id} not found")
        if plan.dropped_keys:
            audit.log(
                "settings.template.key_dropped",
                f"template:{template_id}",
                actor=actor,
                outcome="success",
                detail={"keys": plan.dropped_keys},
            )
        if plan.filled_keys:
            audit.log(
                "settings.template.key_filled",
                f"template:{template_id}",
                actor=actor,
                outcome="success",
                detail={"keys": plan.filled_keys},
            )
        if plan.validation_errors:
            return _validation_response(plan.validation_errors)
        before_snap = dict(STORE.snapshot())
        try:
            result = STORE.apply_diff(
                plan.cleaned_diff,
                actor=actor,
                expected_revision_hash=body.expected_revision_hash,
                confirm_privacy_change=body.confirm_privacy_change,
            )
        except RevisionConflict as exc:
            return _conflict_response(exc.expected, exc.actual)
        except PrivacyConfirmRequired as exc:
            return JSONResponse(
                status_code=400,
                content={"error": "privacy_confirm_required", "key": exc.key},
            )
        except SettingsValidationError as exc:
            return _validation_response(exc.errors)
        after_snap = dict(STORE.snapshot())
        changed_keys = sorted(plan.cleaned_diff.keys())
        audit_id: str | None = None
        if changed_keys:
            audit_id = impact_monitor.on_settings_change(
                before_snap, after_snap, actor_label=actor, changed_keys=changed_keys
            )
        if result.applied_now or result.pending_restart:
            _record_apply_attempt(actor)
        settings_db.insert_apply_log(
            actor_label=actor,
            revision_hash_before=result.revision_hash_before,
            revision_hash_after=result.revision_hash_after,
            result="template_apply",
            warnings=result.warnings,
            payload={"template_id": template_id, "diff": plan.cleaned_diff},
            audit_id=audit_id,
        )
        audit.log(
            "settings.template.apply",
            f"template:{template_id}",
            actor=actor,
            outcome="success",
            detail={"audit_id": audit_id, "applied_now": result.applied_now},
        )
        payload = _result_payload(result)
        payload["audit_id"] = audit_id
        payload["template_id"] = template_id
        return payload

    # ------------------------------------------------------------------
    # Baseline capture
    # ------------------------------------------------------------------
    @app.post("/api/settings/baseline/capture")
    async def capture_baseline(request: Request):
        """Manually open an impact session WITHOUT changing settings.

        Snapshots the current state as both "before" and "after" so
        operators can start an impact-observation window from a known
        quiet baseline. Useful for A/B-style experiments where you want
        to compare the CURRENT configuration against itself before
        trying a change.
        """
        actor = _actor(request)
        snap = dict(STORE.snapshot())
        audit_id = impact_monitor.on_settings_change(
            snap, snap, actor_label=actor, changed_keys=[]
        )
        return {"ok": True, "audit_id": audit_id}

    # ------------------------------------------------------------------
    # Ticket exchange + SSE
    # ------------------------------------------------------------------
    @app.post("/api/settings/stream_ticket")
    async def stream_ticket(body: StreamTicketBody, request: Request):
        """Mint a single-use ticket for the impact SSE.

        EventSource can't send custom headers, so the FE ImpactCard first
        POSTs here (normal request, headers intact) to get a token, then
        connects to ``/api/settings/impact/stream?ticket=<token>``.
        Single-use + 30 s TTL keeps replay windows narrow.
        """
        actor = _actor(request, body.operator_label)
        ticket, ttl = await _issue_ticket(actor)
        audit.log(
            "settings.stream_ticket.issued",
            "ticket",
            actor=actor,
            outcome="success",
            detail={"ttl_sec": ttl},
        )
        return {"ticket": ticket, "expires_in": ttl}

    @app.get("/api/settings/impact/stream")
    async def impact_stream(ticket: str = Query(...)):
        """SSE stream of impact-report updates (ticket-gated).

        The FE ImpactCard opens this after minting a ticket. Each
        subscriber gets its own bounded queue appended to
        ``impact_subscribers``; the apply handler fans out updates via
        :func:`_broadcast`. The generator drops the queue back off the
        list on disconnect so the subscriber set stays accurate.

        - First frame: a ``snapshot`` event carrying the current
          report, so a late subscriber doesn't have to wait for the
          next apply to see any state.
        - Heartbeats: ``: ping`` comment lines every ~15 s to prevent
          idle connections from being axed by reverse proxies.
        - Backpressure: the queue is bounded (maxsize=64); the
          broadcaster drops on ``QueueFull`` rather than blocking the
          apply.
        """
        actor = await _consume_ticket(ticket)
        if actor is None:
            audit.log(
                "settings.stream_ticket.rejected",
                "ticket",
                outcome="denied",
                detail={"reason": "missing_or_expired"},
            )
            raise HTTPException(status_code=401, detail="invalid or expired ticket")

        # Per-subscriber queue; bounded so a slow consumer can't balloon memory.
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        impact_subscribers.append(queue)

        async def _gen():
            """Async generator that yields SSE-framed messages for one subscriber."""
            try:
                # Initial snapshot.
                report = impact_monitor.current_report()
                if report is not None:
                    yield _sse_pack({"event": "snapshot", "data": report.to_dict()})
                while True:
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        # Heartbeat keeps the connection alive through proxies.
                        yield ": ping\n\n"
                        continue
                    yield _sse_pack(msg)
            finally:
                # Best-effort removal — list might already be emptied
                # during server shutdown.
                if queue in impact_subscribers:
                    impact_subscribers.remove(queue)

        return StreamingResponse(_gen(), media_type="text/event-stream")


def _sse_pack(msg: dict[str, Any]) -> str:
    """Serialise one SSE message in the standard wire format."""
    return f"event: {msg.get('event', 'message')}\ndata: {json.dumps(msg.get('data', {}), default=str)}\n\n"


async def _broadcast(subscribers: list[asyncio.Queue], msg: dict[str, Any]) -> None:
    """Best-effort fan-out to every active SSE subscriber."""
    for q in list(subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            # Drop silently; the SSE channel is best-effort.
            pass
