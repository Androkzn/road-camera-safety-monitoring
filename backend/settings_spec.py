"""Settings Console — registry of operator-tunable runtime parameters.

This module is the **single source of truth** for the v1 Settings Console
schema. It defines:

* :data:`SCHEMA_VERSION` — bump when the registry's *shape* changes
  (new keys, removed keys, type changes). The number is written into every
  template payload so older saved templates can be migrated forward at
  apply time.
* :class:`SettingSpec` — metadata describing one tunable knob.
* :data:`SETTINGS_SPEC` — the curated list of tunables shipped in v1.
* :func:`defaults` — `{key: default_value}` dict used to seed
  :class:`backend.settings_store.SettingsStore`.
* :func:`validate` — full validation pass: type, range, enum, and the
  cross-field invariants that operators must not be able to break.

The registry is intentionally compact (~16 entries). Adding a knob is a
two-line change here plus a hot-path snapshot read in the consuming module.

Design notes
------------
* Mutability buckets (``hot_apply`` / ``warm_reload`` / ``restart_required``
  / ``read_only``) are explicit so the API can return
  ``{applied_now: [...], pending_restart: [...]}`` after every apply
  without guessing.
* Defaults are sourced from ``backend.config`` and the per-module
  literals so a fresh boot with the store enabled keeps the *exact* current
  behaviour. This means the v1 rollout is a no-op until the operator
  changes something.
* Cross-field validators are in this module (not the store) so they are
  testable in isolation and so the API's ``/validate`` endpoint can return
  per-key reasons before any apply attempt.

Contract surface
----------------
* Backend consumers — :mod:`backend.settings_store` uses
  :func:`defaults` to seed the snapshot and :func:`validate` on every
  ``apply_diff``. Perception modules do not import from this file
  directly; they read values via ``STORE.snapshot()``.
* API layer — ``backend/api/settings.py`` serves
  :func:`schema_payload` at ``GET /api/settings/schema`` and uses
  :func:`changed_mutability` to bucket apply responses.
* FE — ``frontend/src/features/settings/useSettings.ts`` fetches the
  schema and renders :data:`SETTINGS_SPEC` as the form on SettingsPage.

UI connection
-------------
Page: SettingsPage ([SettingsPage.tsx](frontend/src/features/settings/SettingsPage.tsx)).
UI element: Powers every tunable slider/input on the Settings page.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from backend.config import (
    ALPR_MODE,
    MAX_RECENT_EVENTS,
    PAIR_COOLDOWN_SEC,
    TARGET_FPS,
    VALIDATOR_ENABLED,
    VALIDATOR_IOU_THRESHOLD,
    VALIDATOR_SAMPLE_SEC,
)


# Bump when the shape of ``SETTINGS_SPEC`` changes (add/remove key, type
# change, semantic re-meaning). Templates persisted with an older value
# will be migration candidates at apply time. Do NOT bump for default or
# range tweaks — those ride on the existing schema.
SCHEMA_VERSION = 1


@dataclass(frozen=True)
class SettingSpec:
    """Static metadata for one tunable.

    Attributes:
        key: Stable machine name. Becomes the dict key in the settings
            snapshot. Convention: SCREAMING_SNAKE_CASE matching the original
            module-level constant where possible.
        default: Built-in default. Used at boot to seed the store and as
            the value the synthetic ``tpl_default`` template returns.
        type: One of ``"float"``, ``"int"``, ``"bool"``, ``"str"``,
            ``"enum"``. Drives client-side rendering and server-side coercion.
        category: UI grouping label (``detection``, ``risk-tier``,
            ``alerting``, ``llm-cost``, ``quality``, ``privacy``,
            ``performance``, ``dedup``, ``gating``).
        mutability: One of ``"hot_apply"``, ``"warm_reload"``,
            ``"restart_required"``, ``"read_only"``.
        description: Short operator-facing help text.
        min_value / max_value: Numeric range bounds (inclusive). Required
            for numeric types; ignored for booleans and enums.
        enum_values: For ``type == "enum"``, the allowed string values.
        requires_privacy_confirm: When True, mutating this key requires the
            ``confirm_privacy_change`` flag on the apply request.
    """

    key: str
    default: Any
    type: str
    category: str
    mutability: str
    description: str
    min_value: float | None = None
    max_value: float | None = None
    enum_values: tuple[str, ...] | None = None
    requires_privacy_confirm: bool = False
    step: float | None = None
    """UI slider step. ``None`` means the frontend picks a 'nice' default
    based on the type and range. Set explicitly when the auto-default would
    give awkward fractional increments (e.g. for ``PAIR_COOLDOWN_SEC`` we
    want whole-second snaps)."""


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
# Order matters only for UI rendering — keep grouped by category. Categories
# used: detection, risk-tier, gating, quality, llm-cost, alerting, privacy,
# dedup, performance. ``schema_payload()`` derives the distinct set for the
# FE to build its accordion headers.
SETTINGS_SPEC: list[SettingSpec] = [
    # --- detection ---------------------------------------------------------
    SettingSpec(
        key="CONF_THRESHOLD",
        default=0.50,
        type="float",
        category="detection",
        mutability="hot_apply",
        description="YOLO confidence floor for vehicle classes.",
        min_value=0.10,
        max_value=0.95,
    ),
    SettingSpec(
        key="PERSON_CONF_THRESHOLD",
        default=0.25,
        type="float",
        category="detection",
        mutability="hot_apply",
        description="YOLO confidence floor for person class.",
        min_value=0.10,
        max_value=0.95,
    ),
    SettingSpec(
        key="VEHICLE_PAIR_CONF_FLOOR",
        default=0.60,
        type="float",
        category="detection",
        mutability="hot_apply",
        description="Mean confidence floor for vehicle-vehicle pair events.",
        min_value=0.30,
        max_value=0.95,
    ),
    SettingSpec(
        key="MIN_BBOX_AREA",
        default=1200,
        type="int",
        category="detection",
        mutability="hot_apply",
        description="Minimum bbox area (px^2) for vehicle detections.",
        min_value=400,
        max_value=4000,
    ),
    # --- risk-tier ---------------------------------------------------------
    SettingSpec(
        key="TTC_HIGH_SEC",
        default=0.5,
        type="float",
        category="risk-tier",
        mutability="hot_apply",
        description="Time-to-collision (s) for HIGH risk classification.",
        min_value=0.05,
        max_value=3.0,
    ),
    SettingSpec(
        key="TTC_MED_SEC",
        default=1.0,
        type="float",
        category="risk-tier",
        mutability="hot_apply",
        description="Time-to-collision (s) for MEDIUM risk classification.",
        min_value=0.10,
        max_value=6.0,
    ),
    SettingSpec(
        key="DIST_HIGH_M",
        default=2.0,
        type="float",
        category="risk-tier",
        mutability="hot_apply",
        description="Inter-object distance (m) for HIGH risk classification.",
        min_value=0.5,
        max_value=20.0,
    ),
    SettingSpec(
        key="DIST_MED_M",
        default=5.0,
        type="float",
        category="risk-tier",
        mutability="hot_apply",
        description="Inter-object distance (m) for MEDIUM risk classification.",
        min_value=1.0,
        max_value=50.0,
    ),
    # --- gating ------------------------------------------------------------
    SettingSpec(
        key="MIN_SCALE_GROWTH",
        default=1.10,
        type="float",
        category="gating",
        mutability="hot_apply",
        description="Min bbox scale growth ratio to count as 'approaching'.",
        min_value=1.01,
        max_value=2.0,
    ),
    SettingSpec(
        key="TRACK_HISTORY_LEN",
        default=12,
        type="int",
        category="gating",
        mutability="warm_reload",
        description="Per-track trailing history window for TTC math.",
        min_value=4,
        max_value=60,
    ),
    # --- quality -----------------------------------------------------------
    SettingSpec(
        key="QUALITY_BLUR_SHARP",
        default=40.0,
        type="float",
        category="quality",
        mutability="hot_apply",
        description="Laplacian variance below = blurred / dirty lens.",
        min_value=10.0,
        max_value=200.0,
    ),
    SettingSpec(
        key="QUALITY_LOW_LIGHT_LUM",
        default=45.0,
        type="float",
        category="quality",
        mutability="hot_apply",
        description="Mean grayscale luminance below = degraded_low_light.",
        min_value=10.0,
        max_value=120.0,
    ),
    # --- llm-cost ----------------------------------------------------------
    SettingSpec(
        key="LLM_BUCKET_CAPACITY",
        default=3.0,
        type="float",
        category="llm-cost",
        mutability="warm_reload",
        description="Burst capacity (tokens) of the shared LLM bucket.",
        min_value=1.0,
        max_value=20.0,
        step=1.0,            # whole tokens — fractional capacity is meaningless
    ),
    SettingSpec(
        key="LLM_BUCKET_REFILL_PER_MIN",
        default=3.0,
        type="float",
        category="llm-cost",
        mutability="warm_reload",
        description="Refill rate of the LLM bucket in tokens per minute.",
        min_value=1.0,
        max_value=60.0,
        step=1.0,            # whole tokens / minute
    ),
    # --- alerting ----------------------------------------------------------
    SettingSpec(
        key="SLACK_HIGH_MIN_CONFIDENCE",
        default=0.55,
        type="float",
        category="alerting",
        mutability="hot_apply",
        description="Slack high-tier alerts require this peak confidence.",
        min_value=0.30,
        max_value=0.95,
    ),
    # --- privacy -----------------------------------------------------------
    SettingSpec(
        key="ALPR_MODE",
        default=str(ALPR_MODE),
        type="enum",
        category="privacy",
        mutability="hot_apply",
        description="External ALPR call posture.",
        enum_values=("off", "on", "on_demand"),
        requires_privacy_confirm=True,
    ),
    # --- dedup -------------------------------------------------------------
    SettingSpec(
        key="PAIR_COOLDOWN_SEC",
        default=float(PAIR_COOLDOWN_SEC),
        type="float",
        category="dedup",
        mutability="hot_apply",
        description="Suppress repeat events from the same track pair.",
        min_value=1.0,
        max_value=60.0,
        step=1.0,            # whole seconds — fractional cooldowns add no value
    ),
    # --- performance -------------------------------------------------------
    SettingSpec(
        key="MAX_RECENT_EVENTS",
        default=int(MAX_RECENT_EVENTS),
        type="int",
        category="performance",
        mutability="hot_apply",
        description="In-memory ring-buffer size for recent events.",
        min_value=50,
        max_value=5000,
    ),
    SettingSpec(
        key="TARGET_FPS",
        default=float(TARGET_FPS),
        type="float",
        category="performance",
        mutability="warm_reload",
        description="Perception loop tick rate. Live streams restart to pick up the new rate.",
        min_value=0.5,
        max_value=24.0,
        step=0.5,            # half-fps snaps; finer granularity isn't useful
    ),
    # --- validator (dual-model shadow detector) ----------------------------
    SettingSpec(
        key="VALIDATOR_ENABLED",
        default=bool(VALIDATOR_ENABLED),
        type="bool",
        category="performance",
        mutability="restart_required",
        description="Run a heavier secondary detector in the background to flag primary disagreements. Restart required to load weights.",
    ),
    SettingSpec(
        key="VALIDATOR_SAMPLE_SEC",
        default=float(VALIDATOR_SAMPLE_SEC),
        type="float",
        category="performance",
        mutability="hot_apply",
        description="Seconds between sampled validator jobs per source. Lower = more compute, higher = more misses.",
        min_value=0.5,
        max_value=60.0,
        step=0.5,
    ),
    SettingSpec(
        key="VALIDATOR_IOU_THRESHOLD",
        default=float(VALIDATOR_IOU_THRESHOLD),
        type="float",
        category="performance",
        mutability="hot_apply",
        description="Minimum IoU for primary/secondary bbox match. Higher = stricter agreement.",
        min_value=0.1,
        max_value=0.9,
        step=0.05,
    ),
]


# O(1) key lookup cache, built once at import. ``SETTINGS_SPEC`` is frozen
# at module-scope so this map never needs invalidation.
_BY_KEY: dict[str, SettingSpec] = {s.key: s for s in SETTINGS_SPEC}


def spec_for(key: str) -> SettingSpec | None:
    """Return the spec for ``key`` or ``None`` if unknown.

    Inputs:
        key: Candidate setting key; arbitrary string, no normalization.
    Outputs:
        The matching :class:`SettingSpec` or ``None``.
    Side effects: none.
    """
    return _BY_KEY.get(key)


def all_keys() -> list[str]:
    """Return the list of registry keys in registration order.

    Registration order is the category-grouped order of
    :data:`SETTINGS_SPEC`; the FE relies on it to render grouped sections
    deterministically.
    """
    return [s.key for s in SETTINGS_SPEC]


def defaults() -> dict[str, Any]:
    """Return ``{key: default}`` for every spec entry.

    Used by :class:`backend.settings_store.SettingsStore` to seed its
    first snapshot. A fresh boot therefore matches the exact ``backend.config``
    defaults, guaranteeing the Settings Console is a no-op until the operator
    edits something.
    """
    return {s.key: s.default for s in SETTINGS_SPEC}


def coerce(key: str, value: Any) -> Any:
    """Coerce a JSON-decoded ``value`` into the spec's type.

    Permissive on the way in (so the UI can post strings for numbers without
    a 422), strict on the spec contract (returns the canonical type).
    Returns ``value`` unchanged when ``key`` is unknown — the caller
    decides whether unknown keys are an error.

    Inputs:
        key: Registry key; unknown keys pass through untouched.
        value: Raw JSON-decoded value from the request body.
    Outputs:
        Value converted to the declared ``spec.type``.
    Validation:
        * ``bool`` accepts the common truthy strings (``1``, ``true``,
          ``yes``, ``on``) to be tolerant of FE checkbox submission.
        * ``enum`` is lowercased and stripped before matching.
    Side effects: none.
    """
    spec = spec_for(key)
    if spec is None:
        return value
    if spec.type == "int":
        return int(value)
    if spec.type == "float":
        return float(value)
    if spec.type == "bool":
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if spec.type in ("str", "enum"):
        return str(value).strip().lower() if spec.type == "enum" else str(value)
    return value


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
# ``ValidationError`` is a lightweight alias — we return plain dicts of the
# form ``{"key": str, "reason": str}`` rather than a dataclass so the API
# layer can pass the list straight through to the 422 body without
# remarshalling.
ValidationError = dict  # {key, reason}


def _per_key_errors(merged: dict[str, Any]) -> list[ValidationError]:
    """Range / enum / type checks applied to each entry in ``merged``.

    ``merged`` is the prospective full snapshot after a diff is folded in
    — i.e. it contains every registry key, not just changed ones.

    Validation layers, short-circuiting per key:
      1. Presence  (missing key → error, continue to next key)
      2. Type      (int / float / bool / str / enum)
      3. Range     (min/max for numeric types)
      4. Enum set  (membership in ``spec.enum_values``)

    Note: ``bool`` is excluded from the numeric check via
    ``isinstance(v, bool)`` because Python's ``bool`` subclasses ``int``.
    """
    errs: list[ValidationError] = []
    for spec in SETTINGS_SPEC:
        if spec.key not in merged:
            errs.append({"key": spec.key, "reason": "missing required key"})
            continue
        v = merged[spec.key]
        if spec.type == "int":
            if not isinstance(v, int) or isinstance(v, bool):
                errs.append({"key": spec.key, "reason": f"expected int, got {type(v).__name__}"})
                continue
        elif spec.type == "float":
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                errs.append({"key": spec.key, "reason": f"expected number, got {type(v).__name__}"})
                continue
        elif spec.type == "bool":
            if not isinstance(v, bool):
                errs.append({"key": spec.key, "reason": f"expected bool, got {type(v).__name__}"})
                continue
        elif spec.type == "str":
            if not isinstance(v, str):
                errs.append({"key": spec.key, "reason": f"expected str, got {type(v).__name__}"})
                continue
        elif spec.type == "enum":
            if not isinstance(v, str) or (spec.enum_values and v not in spec.enum_values):
                allowed = ",".join(spec.enum_values or ())
                errs.append({"key": spec.key, "reason": f"must be one of {{{allowed}}}"})
                continue
        if spec.type in ("int", "float"):
            if spec.min_value is not None and v < spec.min_value:
                errs.append({"key": spec.key, "reason": f"below minimum {spec.min_value}"})
            if spec.max_value is not None and v > spec.max_value:
                errs.append({"key": spec.key, "reason": f"above maximum {spec.max_value}"})
    return errs


def _cross_field_errors(merged: dict[str, Any]) -> list[ValidationError]:
    """Cross-field invariants. Hand-authored — keep this list short.

    Each rule encodes a semantic relationship that isolated per-key bounds
    cannot express (e.g. MED thresholds must be strictly looser than HIGH
    thresholds, otherwise the risk-tier classifier collapses).

    The ``KeyError`` fallback protects against a partially-constructed
    ``merged`` snapshot during dev; in production ``_per_key_errors`` runs
    first and would already have flagged the absence.
    """
    errs: list[ValidationError] = []
    try:
        if merged["TTC_MED_SEC"] <= merged["TTC_HIGH_SEC"]:
            errs.append({"key": "TTC_MED_SEC", "reason": "must be > TTC_HIGH_SEC"})
        if merged["DIST_MED_M"] <= merged["DIST_HIGH_M"]:
            errs.append({"key": "DIST_MED_M", "reason": "must be > DIST_HIGH_M"})
        if merged["MIN_SCALE_GROWTH"] <= 1.0:
            errs.append({"key": "MIN_SCALE_GROWTH", "reason": "must be > 1.0"})
        if merged["LLM_BUCKET_CAPACITY"] < 1:
            errs.append({"key": "LLM_BUCKET_CAPACITY", "reason": "must be >= 1"})
        # Note: SLACK_HIGH_MIN_CONFIDENCE < CONF_THRESHOLD is allowed. Detection
        # already filters out anything below CONF_THRESHOLD, so a lower Slack
        # floor is simply redundant — not incorrect. Blocking apply on this
        # was hostile UX (operator raises CONF_THRESHOLD and the apply fails
        # referencing a field they didn't touch). Leave it to the operator.
    except KeyError as exc:
        errs.append({"key": str(exc).strip("'"), "reason": "missing for cross-field check"})
    return errs


def validate(merged: dict[str, Any]) -> list[ValidationError]:
    """Run the full validation pipeline against a *merged* snapshot.

    The caller is responsible for layering a diff on top of the current
    snapshot before calling this. This separation keeps the validator a
    pure function of the prospective end state.

    Inputs:
        merged: Candidate full snapshot — must contain every registry key.
    Outputs:
        Flat list of ``{key, reason}`` dicts. Empty list means "valid".
    Side effects: none (pure function, safe to call from the API layer
        before any mutation).
    """
    # Per-key errors first so cross-field rules can safely assume all keys
    # are present and of the right type.
    return _per_key_errors(merged) + _cross_field_errors(merged)


def changed_mutability(diff: dict[str, Any]) -> dict[str, list[str]]:
    """Bucket the keys touched by ``diff`` by their mutability class.

    Used by :meth:`SettingsStore.apply_diff` to populate
    ``applied_now`` vs ``pending_restart`` in the API response, letting the
    FE show "effective immediately" vs "restart required" chips without
    round-tripping the schema.

    Returns a dict like::

        {
            "hot_apply": ["CONF_THRESHOLD", ...],
            "warm_reload": ["TRACK_HISTORY_LEN"],
            "restart_required": ["TARGET_FPS"],
            "read_only": [],   # rejected upstream, but reported for UI clarity
        }

    Unknown keys are silently skipped (the store already warns on those).
    """
    out: dict[str, list[str]] = {
        "hot_apply": [],
        "warm_reload": [],
        "restart_required": [],
        "read_only": [],
    }
    for key in diff:
        spec = _BY_KEY.get(key)
        if spec is None:
            continue
        out.setdefault(spec.mutability, []).append(key)
    return out


def schema_payload() -> dict[str, Any]:
    """JSON-serializable description of the registry, for ``GET /api/settings/schema``.

    Consumers:
        * FE hook ``useSettings`` (see
          ``frontend/src/features/settings/useSettings.ts``) — drives the
          dynamic form on SettingsPage.
        * ``scripts/generate_ts_types.py`` does NOT read this; TS types
          come from the pydantic models in ``backend/api/models.py``.
          Only the schema *data* travels over the wire at runtime.

    Spec-to-schema projection: collapses :class:`SettingSpec` dataclass
    fields into the key names the FE expects (``min_value`` → ``min``,
    ``max_value`` → ``max``, ``enum_values`` → ``enum``). The category list
    is derived from the spec at call time so new categories light up in
    the UI without any frontend code change.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "categories": sorted({s.category for s in SETTINGS_SPEC}),
        "settings": [
            {
                "key": s.key,
                "default": s.default,
                "type": s.type,
                "category": s.category,
                "mutability": s.mutability,
                "description": s.description,
                "min": s.min_value,
                "max": s.max_value,
                "step": s.step,
                "enum": list(s.enum_values) if s.enum_values else None,
                "requires_privacy_confirm": s.requires_privacy_confirm,
            }
            for s in SETTINGS_SPEC
        ],
    }
