"""Settings Console — runtime settings store with atomic apply + subscribers.

The store owns one in-memory snapshot of every operator-tunable parameter.
Hot-path code reads it via ``STORE.snapshot()`` (returns a frozen
``MappingProxyType`` view, lock-free for readers) and writes go through
``STORE.apply_diff(...)`` which:

1. Validates the merged snapshot against :mod:`backend.settings_spec`.
2. Honours the ``If-Match`` lost-update protection
   (``expected_revision_hash``).
3. Builds a new immutable snapshot and atomically rebinds it under a short
   ``RLock``.
4. Records the previous snapshot as ``last_known_good`` for ``rollback()``.
5. Fans out to subscribers — each callback runs inside its own
   ``try/except`` so a misbehaving consumer never reverts the snapshot.
6. Returns an :class:`AppliedResult` that the API layer translates into the
   wire response.

The store is a process-wide singleton (``STORE`` at the bottom of the file).
There is exactly one settings snapshot per edge process — out-of-scope for
v1: HA / multi-instance with leader election (see plan §S2).

Contract surface
----------------
* Readers (hot path) — ``backend/core/*`` and ``backend/perception/*``
  call ``STORE.snapshot()`` once per frame. The returned
  ``MappingProxyType`` is an immutable view over the current dict; readers
  never take the store lock.
* Writers (cold path) — ``backend/api/settings.py`` translates
  ``POST /api/settings/apply`` into ``STORE.apply_diff(...)`` and
  ``POST /api/settings/rollback`` into ``STORE.rollback_to_last_good()``.
* Persistence — this module is pure in-memory. A separate collaborator
  (``services/settings_db.py``, registered as a subscriber) mirrors every
  successful apply to SQLite so the snapshot survives a restart.

Concurrency model
-----------------
Exactly one ``RLock`` guards mutation; readers do not participate. The
``RLock`` variant is deliberate — a subscriber callback is allowed to
call ``STORE.snapshot()`` (or in pathological cases, schedule another
apply via its own thread) without deadlocking.

UI connection
-------------
Page: SettingsPage ([SettingsPage.tsx](frontend/src/features/settings/SettingsPage.tsx)).
UI element: Powers every tunable slider/input on the Settings page.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping

from backend import settings_spec


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------
class SettingsValidationError(Exception):
    """Raised by :meth:`SettingsStore.apply_diff` on schema / range failure.

    The ``errors`` attribute is the flat list returned by
    :func:`settings_spec.validate` so the API layer can render it as a 422
    body without further marshalling.
    """

    def __init__(self, errors: list[dict[str, Any]]):
        super().__init__(f"settings validation failed: {len(errors)} error(s)")
        self.errors = errors


class RevisionConflict(Exception):
    """Raised when ``expected_revision_hash`` does not match the live snapshot.

    The store's revision hash advanced between the operator opening the
    page and pressing apply. The API layer translates this into a 409 with
    the current ``revision_hash`` so the UI can prompt for a refresh.
    """

    def __init__(self, expected: str, actual: str):
        super().__init__(f"revision conflict: expected={expected} actual={actual}")
        self.expected = expected
        self.actual = actual


class PrivacyConfirmRequired(Exception):
    """Raised when an ALPR-mode flip is attempted without the explicit confirm."""

    def __init__(self, key: str):
        super().__init__(f"privacy-sensitive change to {key} requires confirm flag")
        self.key = key


@dataclass
class AppliedResult:
    """What the caller learns about an apply (or validate) attempt.

    Attributes:
        ok: Whether the apply landed.
        applied_now: Keys that took effect in this apply (hot/warm).
        pending_restart: Keys whose value was persisted but won't take
            effect until the process restarts (``restart_required``
            mutability class).
        warnings: Subscriber-isolation warnings, e.g. ``"rebuild_bucket: ..."``.
        revision_hash_before / revision_hash_after: Short hashes of the
            snapshot before and after the apply.
        revision_no: Monotonic counter; bumps on every successful apply.
    """

    ok: bool
    applied_now: list[str] = field(default_factory=list)
    pending_restart: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    revision_hash_before: str = ""
    revision_hash_after: str = ""
    revision_no: int = 0


# ---------------------------------------------------------------------------
# Hashing helper
# ---------------------------------------------------------------------------
def _hash_snapshot(snap: Mapping[str, Any]) -> str:
    """Return a short, stable hash of ``snap`` for ``If-Match`` semantics.

    SHA-256 truncated to 16 hex chars is plenty for collision avoidance
    inside a single process and keeps the wire payload tiny.

    Determinism: ``sort_keys=True`` ensures two snapshots with identical
    contents but different insertion order hash to the same value, which
    is required for the FE's ``If-Match`` revision-compare to be correct
    across reloads. ``default=str`` protects against accidental
    non-JSON-native values (e.g. ``Path``) leaking into the snapshot.
    """
    payload = json.dumps(snap, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Subscriber bookkeeping
# ---------------------------------------------------------------------------
@dataclass
class _Subscriber:
    """One registered ``(before, after)`` listener.

    Attributes:
        callback: Fires after every successful apply. Must not raise —
            exceptions are caught and surfaced as warnings.
        keys: Narrow filter; when non-``None`` the callback only fires if
            one of these keys changed. ``None`` means "fire on every apply".
        name: Human-friendly label for warning messages + observability.
    """

    callback: Callable[[Mapping[str, Any], Mapping[str, Any]], None]
    keys: tuple[str, ...] | None  # None == fire on every apply
    name: str


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------
class SettingsStore:
    """Process-wide settings snapshot with atomic apply + subscribers.

    Readers
    -------
    Hot-path code calls :meth:`snapshot` once per frame and uses the
    returned frozen mapping for the duration. The reader path is lock-free
    and O(1) — it is just an attribute read.

    Writers
    -------
    Writers go through :meth:`apply_diff`. The diff is validated against
    the merged prospective snapshot, the snapshot is atomically swapped,
    and registered subscribers are fanned out **after** the swap so a
    crashing subscriber cannot leave the store half-applied.
    """

    def __init__(self, initial: Mapping[str, Any] | None = None):
        """Seed the store from :func:`settings_spec.defaults`, overlayed with ``initial``.

        Inputs:
            initial: Optional dict of previously-persisted values loaded by
                ``services/settings_db.py`` at boot. Merged on top of
                defaults so a new key added to the spec inherits its default
                without requiring a DB migration.
        Raises:
            SettingsValidationError: If the resulting seed fails validation
                — treated as a programming error, not a runtime error.
        """
        seed = dict(settings_spec.defaults())
        if initial:
            seed.update(initial)
        # Validate the seed eagerly — a misconfigured default is a programming
        # error, not a runtime error, so we want it to surface at boot.
        errors = settings_spec.validate(seed)
        if errors:
            raise SettingsValidationError(errors)
        # The snapshot is stored as a MappingProxyType so readers cannot
        # mutate it. New snapshots are built and rebound atomically; the
        # existing view remains valid to any thread that already grabbed it.
        self._snapshot: Mapping[str, Any] = MappingProxyType(seed)
        self._last_good: Mapping[str, Any] = self._snapshot
        self._revision_no: int = 1
        # ``RLock`` (re-entrant) so a subscriber can call back into the
        # store (e.g. read ``snapshot()``) without deadlocking.
        self._lock = threading.RLock()
        self._subscribers: list[_Subscriber] = []
        # Counters surfaced by the observability endpoints
        # (GET /api/settings/metrics). Never reset during the process
        # lifetime; Prometheus / ops treat these as monotonic.
        self.counters: dict[str, int] = {
            "settings_apply_total_success": 0,
            "settings_apply_total_validation_error": 0,
            "settings_apply_total_subscriber_error": 0,
            "settings_apply_total_conflict": 0,
            "settings_rollback_total": 0,
        }

    # ------------------------------------------------------------------
    # Snapshot reads
    # ------------------------------------------------------------------
    def snapshot(self) -> Mapping[str, Any]:
        """Return the current frozen snapshot (cheap, lock-free).

        The returned mapping is a ``MappingProxyType``. Callers must treat
        it as read-only; attempting to mutate raises ``TypeError``.
        Intended for per-frame access in the perception hot path — no lock
        is taken on the reader side.
        """
        return self._snapshot

    def revision_hash(self) -> str:
        """Short stable hash of the current snapshot for ``If-Match`` flows.

        The FE captures this value when it reads the schema and passes it
        back as ``expected_revision_hash`` on apply; a mismatch means
        someone else edited the snapshot in between and the FE should
        refresh instead of clobbering.
        """
        return _hash_snapshot(self._snapshot)

    def revision_no(self) -> int:
        """Monotonic apply counter (informational; not for concurrency).

        Unlike :meth:`revision_hash`, this does NOT discriminate between
        two applies that land on identical content. Use only for logs
        and the UI; use the hash for optimistic concurrency.
        """
        return self._revision_no

    # ------------------------------------------------------------------
    # Subscribers
    # ------------------------------------------------------------------
    def register_subscriber(
        self,
        callback: Callable[[Mapping[str, Any], Mapping[str, Any]], None],
        *,
        name: str | None = None,
    ) -> None:
        """Register a callback that fires after **every** successful apply.

        ``callback(before, after)`` runs on the apply thread inside the
        store lock. It MUST NOT raise; if it does, the exception is logged
        as a warning and surfaced in :class:`AppliedResult.warnings` —
        the snapshot is not rolled back.

        Side effects: appends to the internal subscriber list. There is no
        ``unregister`` — subscribers live for the process lifetime.
        """
        self._subscribers.append(
            _Subscriber(callback=callback, keys=None, name=name or callback.__name__)
        )

    def register_subscriber_for(
        self,
        keys: Iterable[str],
        callback: Callable[[Mapping[str, Any], Mapping[str, Any]], None],
        *,
        name: str | None = None,
    ) -> None:
        """Register a callback that fires only when one of ``keys`` changes.

        Inputs:
            keys: Iterable of registry keys to watch. An apply that
                changes none of these keys skips the callback entirely.
            callback: ``(before, after)`` hook. Same isolation rules as
                :meth:`register_subscriber`.
            name: Optional override for the warning/observability label.
        """
        self._subscribers.append(
            _Subscriber(
                callback=callback,
                keys=tuple(keys),
                name=name or callback.__name__,
            )
        )

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------
    def apply_diff(
        self,
        diff: Mapping[str, Any],
        *,
        actor: str = "system",
        expected_revision_hash: str | None = None,
        confirm_privacy_change: bool = False,
    ) -> AppliedResult:
        """Atomically merge ``diff`` into the snapshot.

        Args:
            diff: ``{key: new_value}`` for each key the caller wants to
                change. Unknown keys are ignored (with a warning) so that
                stale UI clients don't 422 on retired knobs.
            actor: Free-text label for audit logs (POC has no user accounts).
            expected_revision_hash: Pass the ``revision_hash`` the operator
                saw when they opened the page. If the live snapshot has
                advanced, raises :class:`RevisionConflict`.
            confirm_privacy_change: Must be True when ``diff`` touches a
                key with ``requires_privacy_confirm=True`` (e.g.
                ``ALPR_MODE``). Otherwise raises :class:`PrivacyConfirmRequired`.

        Raises:
            RevisionConflict: Lost-update protection tripped.
            PrivacyConfirmRequired: Privacy-sensitive change without consent.
            SettingsValidationError: Per-key or cross-field validation failed.

        Returns:
            :class:`AppliedResult` with the applied + pending-restart key
            lists and any subscriber warnings.
        """
        # The entire apply — validation, swap, fan-out — runs under one
        # lock. Readers never take this lock; they just observe the rebind
        # via the ``self._snapshot`` attribute read.
        with self._lock:
            before = self._snapshot
            before_hash = _hash_snapshot(before)

            # Optimistic-concurrency (lost-update) check. The FE passes back
            # the hash it saw when it opened the page; a divergence means
            # another apply landed in between and we must refuse rather
            # than silently stomp it.
            if expected_revision_hash and expected_revision_hash != before_hash:
                self.counters["settings_apply_total_conflict"] += 1
                raise RevisionConflict(expected_revision_hash, before_hash)

            # Coerce types and drop unknown keys.
            warnings: list[str] = []
            cleaned: dict[str, Any] = {}
            for key, raw in diff.items():
                # Unknown / stale keys are a warning, not a hard error, so
                # that a cached FE build with a retired knob doesn't 422.
                if settings_spec.spec_for(key) is None:
                    warnings.append(f"unknown key dropped: {key}")
                    continue
                spec = settings_spec.spec_for(key)
                if spec.mutability == "read_only":
                    warnings.append(f"read-only key ignored: {key}")
                    continue
                # Privacy-sensitive keys (ALPR_MODE) require an explicit
                # opt-in flag to prevent accidental regulatory exposure.
                if spec.requires_privacy_confirm and not confirm_privacy_change:
                    raise PrivacyConfirmRequired(key)
                try:
                    cleaned[key] = settings_spec.coerce(key, raw)
                except (TypeError, ValueError) as exc:
                    self.counters["settings_apply_total_validation_error"] += 1
                    raise SettingsValidationError(
                        [{"key": key, "reason": f"coercion failed: {exc}"}]
                    )

            if not cleaned:
                # Nothing to do — return a no-op result. We still bump nothing
                # so callers can detect "applied but no change".
                return AppliedResult(
                    ok=True,
                    applied_now=[],
                    pending_restart=[],
                    warnings=warnings,
                    revision_hash_before=before_hash,
                    revision_hash_after=before_hash,
                    revision_no=self._revision_no,
                )

            # Build the prospective merged snapshot. ``dict(before)`` copies
            # the frozen view into a mutable dict we can overlay the diff on.
            merged = dict(before)
            merged.update(cleaned)

            # Full re-validation (per-key + cross-field) on the prospective
            # end state. Must run BEFORE the swap so failure leaves the
            # store untouched.
            errors = settings_spec.validate(merged)
            if errors:
                self.counters["settings_apply_total_validation_error"] += 1
                raise SettingsValidationError(errors)

            # Atomic snapshot swap. Until this rebind, readers see the old
            # snapshot; after it, readers see the new one. Subscribers run
            # AFTER the swap so a subscriber crash cannot revert state.
            self._last_good = before
            self._snapshot = MappingProxyType(merged)
            self._revision_no += 1
            after_hash = _hash_snapshot(self._snapshot)

            # Split the applied keys into "took effect now" vs
            # "persisted, needs restart" so the FE can badge them.
            buckets = settings_spec.changed_mutability(cleaned)
            applied_now = sorted(buckets.get("hot_apply", []) + buckets.get("warm_reload", []))
            pending_restart = sorted(buckets.get("restart_required", []))

            # Fan-out collects warnings; any subscriber exception becomes a
            # warning string rather than rolling back the snapshot.
            warnings.extend(self._fan_out(before, self._snapshot, list(cleaned.keys())))

            self.counters["settings_apply_total_success"] += 1
            return AppliedResult(
                ok=True,
                applied_now=applied_now,
                pending_restart=pending_restart,
                warnings=warnings,
                revision_hash_before=before_hash,
                revision_hash_after=after_hash,
                revision_no=self._revision_no,
            )

    def rollback_to_last_good(self, *, actor: str = "system") -> AppliedResult:
        """Restore the snapshot that was active immediately before the last apply.

        A no-op (returns ``ok=True`` with empty lists) when nothing has been
        applied since boot — the API layer translates that into a 409 if
        the operator clicked rollback with no eligible target.

        Note on rollback semantics: after rollback, the new
        ``_last_good`` points at the snapshot we just *rolled back from*,
        so a second rollback call moves forward to where we were a
        moment ago. This gives the operator an "undo/redo" toggle rather
        than a one-way Ctrl-Z.

        Side effects: swaps the snapshot, bumps ``_revision_no``, fires
        subscribers, bumps ``settings_rollback_total``.
        """
        with self._lock:
            before = self._snapshot
            before_hash = _hash_snapshot(before)
            if self._last_good is before:
                return AppliedResult(
                    ok=True,
                    applied_now=[],
                    pending_restart=[],
                    warnings=["no rollback target — store at last-known-good already"],
                    revision_hash_before=before_hash,
                    revision_hash_after=before_hash,
                    revision_no=self._revision_no,
                )
            target = self._last_good
            # Stash the current snapshot as the new last_good so an operator
            # who hits rollback twice can return to where they started.
            self._last_good = before
            self._snapshot = target
            self._revision_no += 1
            after_hash = _hash_snapshot(self._snapshot)
            changed_keys = [k for k in target if target[k] != before.get(k)]
            warnings = self._fan_out(before, self._snapshot, changed_keys)
            self.counters["settings_rollback_total"] += 1
            buckets = settings_spec.changed_mutability({k: target[k] for k in changed_keys})
            return AppliedResult(
                ok=True,
                applied_now=sorted(buckets.get("hot_apply", []) + buckets.get("warm_reload", [])),
                pending_restart=sorted(buckets.get("restart_required", [])),
                warnings=warnings,
                revision_hash_before=before_hash,
                revision_hash_after=after_hash,
                revision_no=self._revision_no,
            )

    # ------------------------------------------------------------------
    # Subscriber fan-out (private)
    # ------------------------------------------------------------------
    def _fan_out(
        self,
        before: Mapping[str, Any],
        after: Mapping[str, Any],
        changed_keys: list[str],
    ) -> list[str]:
        """Run subscribers, isolating exceptions into warnings.

        Inputs:
            before: Snapshot prior to the swap (for subscribers that need
                to diff values, e.g. to rebuild a cached LLM token bucket).
            after: Newly-active snapshot.
            changed_keys: Keys touched by this apply. Used to short-circuit
                subscribers registered with a narrow key filter.

        Outputs:
            List of ``"<name>: <error>"`` warning strings, one per
            subscriber that raised. Empty on clean runs.

        Side effects: may increment
        ``settings_apply_total_subscriber_error``. Does NOT revert the
        snapshot — that is the whole point of running fan-out *after*
        the swap: a broken consumer cannot poison the store.
        """
        warnings: list[str] = []
        changed_set = set(changed_keys)
        for sub in self._subscribers:
            # Narrow-key filter: subscriber registered via
            # ``register_subscriber_for(keys=...)`` only fires when at
            # least one of its watched keys appears in this apply.
            if sub.keys is not None and not changed_set.intersection(sub.keys):
                continue
            try:
                sub.callback(before, after)
            except Exception as exc:  # noqa: BLE001 — subscribers must never crash apply.
                self.counters["settings_apply_total_subscriber_error"] += 1
                warnings.append(f"{sub.name}: {exc}")
        return warnings


# ---------------------------------------------------------------------------
# Process-wide singleton
# ---------------------------------------------------------------------------
# Constructed at import time with the spec's defaults. ``services/settings_db.py``
# registers a persistence subscriber during FastAPI's lifespan startup and
# overlays any previously-saved values via a subsequent ``apply_diff`` call —
# keeping this module free of DB imports and import-order coupling.
STORE = SettingsStore()
"""Process-wide :class:`SettingsStore` singleton. Import as
``from backend.settings_store import STORE`` and call
``STORE.snapshot()`` in any hot path."""
