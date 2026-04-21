"""Pydantic → TypeScript codegen for the backend-to-frontend contract.

The pydantic models in :mod:`backend.api.models` are the single source of
truth for every JSON payload the backend emits (SSE events, REST responses,
the admin detection stream, watchdog incidents, test runner output, …).
This script walks ``EXPORTED_MODELS`` from that module, asks pydantic for
each model's JSON Schema, then emits an equivalent TypeScript interface
(or discriminated union) into
``frontend/src/shared/types/generated.ts``.

**Do not hand-edit the generated file.** The first thing ``start.py`` does
before building the frontend is re-run this script; any manual edit will
be clobbered. To change a shape, edit the pydantic model, then rerun:

    .venv/bin/python scripts/generate_ts_types.py

Design notes
------------

Why hand-rolled rather than ``pydantic-to-typescript`` / ``json2ts``?
    * The upstream Python→TS tools in the ecosystem all shell out to npm
      (``json-schema-to-typescript``). That would force every contributor
      to have Node available to lint the backend, which defeats the split
      between ``make lint`` (pure Python) and ``npm run build`` (Node).
    * The subset of JSON Schema that pydantic v2 emits for our models is
      small — objects with typed properties, ``oneOf`` for unions,
      ``enum`` for Literals, ``$ref`` for nested models, arrays with
      typed items. A ~200-line walker covers it.
    * Keeping the walker in-tree means the generated TS matches our
      naming conventions exactly (PascalCase interfaces, trailing-
      question-mark optionals, no re-exported ``Record<string, any>``).

We strip the trailing ``"Model"`` suffix on pydantic class names so the
emitted TypeScript reads like the original hand-written contract
(``EventModel`` → ``SafetyEvent``, ``SourceStatusModel`` →
``LiveSourceStatus``). The :data:`TS_NAME_OVERRIDES` mapping is the one
place that aliasing lives.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
# Make ``backend`` importable when this script is invoked directly
# (``python scripts/generate_ts_types.py``). Running via ``-m`` would
# also work but requires the caller to remember ``cd`` into the repo.
sys.path.insert(0, str(REPO_ROOT))

from backend.api.models import EXPORTED_MODELS  # noqa: E402  (sys.path tweak above)

OUTPUT_PATH = REPO_ROOT / "frontend" / "src" / "shared" / "types" / "generated.ts"


# ``EventModel`` is the canonical wire name used everywhere in the
# Python code, but the frontend reads nicer if we keep the historical
# ``SafetyEvent`` alias + a couple of others. Everything else just
# drops the ``Model`` suffix.
TS_NAME_OVERRIDES: dict[str, str] = {
    "EventModel": "SafetyEvent",
    "SourceStatusModel": "LiveSourceStatus",
    "LiveStatusResponse": "LiveStatus",
    "AdminHealthResponse": "HealthData",
    "PerceptionStateModel": "PerceptionState",
    "SceneContextModel": "SceneContext",
    "EgoFlowModel": "EgoFlow",
    "EnrichmentModel": "Enrichment",
    "DetectionObjectModel": "DetectionObject",
    "DetectionSnapshotModel": "DetectionSnapshot",
    "DriftReportModel": "DriftReport",
    "WatchdogFindingModel": "WatchdogFinding",
    "WatchdogStatusModel": "WatchdogStatus",
    "WatchdogEvidenceModel": "WatchdogEvidence",
    "WatchdogTopIncidentModel": "WatchdogTopIncident",
    "TestResultModel": "TestResult",
    "TestStatusModel": "TestStatus",
    "StageTimingStatsModel": "StageTimingStats",
    "AdminServerHealthModel": "AdminServerHealth",
    "AdminPipelineHealthModel": "AdminPipelineHealth",
    "AdminIntegrationsHealthModel": "AdminIntegrationsHealth",
}


def ts_name(python_name: str) -> str:
    """Return the TS interface/alias name for a pydantic class name."""
    if python_name in TS_NAME_OVERRIDES:
        return TS_NAME_OVERRIDES[python_name]
    if python_name.endswith("Model"):
        return python_name[: -len("Model")]
    return python_name


def format_literal(value: Any) -> str:
    """Render a JSON-schema ``enum`` literal as its TS source form.

    Only strings / numbers / booleans / null appear in our schemas; anything
    else indicates a schema we don't emit today and raises so we notice.
    """
    if isinstance(value, str):
        return json.dumps(value)  # quotes + escapes
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return str(value)
    raise TypeError(f"unsupported enum literal: {value!r}")


def schema_to_ts(
    schema: dict[str, Any], root_defs: dict[str, dict[str, Any]]
) -> str:
    """Convert one JSON-schema node into a TypeScript type expression.

    ``root_defs`` is the top-level ``$defs`` map from the root schema so
    ``$ref`` lookups can resolve without re-walking every ancestor.
    """
    # `$ref` — delegate to the referenced definition's TS name.
    ref = schema.get("$ref")
    if ref:
        # pydantic emits refs like "#/$defs/EventModel" — we only need
        # the tail segment.
        name = ref.rsplit("/", 1)[-1]
        return ts_name(name)

    # `anyOf` / `oneOf` — union. In pydantic v2, Optional[X] becomes
    # ``{"anyOf": [{"$ref": "..."}, {"type": "null"}]}`` — we flatten
    # ``null`` into the trailing ``| null`` convention used elsewhere.
    union = schema.get("anyOf") or schema.get("oneOf")
    if union:
        parts = [schema_to_ts(sub, root_defs) for sub in union]
        # Merge duplicates while preserving order.
        seen: list[str] = []
        for p in parts:
            if p not in seen:
                seen.append(p)
        return " | ".join(seen)

    # ``enum`` — pydantic emits Literal["a", "b"] as an enum node.
    enum_vals = schema.get("enum")
    if enum_vals is not None:
        return " | ".join(format_literal(v) for v in enum_vals)

    # ``const`` — single-value literal (rare, but pydantic can emit it).
    if "const" in schema:
        return format_literal(schema["const"])

    t = schema.get("type")
    # Handle union types like ``["string", "null"]`` (pydantic sometimes
    # emits this form instead of anyOf).
    if isinstance(t, list):
        parts = [
            schema_to_ts({"type": sub_t, **{k: v for k, v in schema.items() if k != "type"}}, root_defs)
            for sub_t in t
        ]
        return " | ".join(parts)

    if t == "string":
        return "string"
    if t == "integer" or t == "number":
        return "number"
    if t == "boolean":
        return "boolean"
    if t == "null":
        return "null"
    if t == "array":
        # Fixed-length tuples (``tuple[float, float, float, float]``) emit
        # ``prefixItems`` in JSON Schema 2020-12 — render these as TS
        # tuple types so the FE can index into them without triggering
        # ``noUncheckedIndexedAccess``.
        prefix = schema.get("prefixItems")
        if prefix:
            parts = [schema_to_ts(item, root_defs) for item in prefix]
            return "[" + ", ".join(parts) + "]"
        items = schema.get("items")
        if items is None:
            return "unknown[]"
        return f"Array<{schema_to_ts(items, root_defs)}>"
    if t == "object":
        # ``additionalProperties`` with a typed schema → Record<...>.
        # Untyped free-form objects fall back to ``Record<string, unknown>``.
        ap = schema.get("additionalProperties")
        if isinstance(ap, dict):
            return f"Record<string, {schema_to_ts(ap, root_defs)}>"
        if schema.get("properties"):
            # Inline anonymous object (rare — usually these are named $defs).
            return render_object_body(schema, root_defs)
        return "Record<string, unknown>"

    # Fallback for nodes we don't recognise — emit ``unknown`` rather
    # than silently dropping the field so the TS compiler complains
    # loudly at the call site if we introduce an unknown shape.
    return "unknown"


def strip_trailing_null(ts_type: str) -> str:
    """Collapse ``"... | null"`` → ``"..."``.

    Pydantic v2 serializes ``Optional[X] = None`` into a JSON Schema
    anyOf of ``X | null``; the naïve translation is ``X | null`` in TS.
    But every FE call site in this project already uses the
    ``field?: X`` convention (absence = ``undefined``), not explicit
    nulls. Honouring the wire-level nullability would force a ``??``
    coalesce at every usage without adding information — the consumer
    already branches on "missing or present" the same way either way.
    So we strip the trailing ``| null`` for optional fields; fields
    that are genuinely required-but-nullable keep the ``| null`` via
    ``strip_trailing_null`` being called only inside the optional
    branch of ``render_object_body``.
    """
    parts = [p.strip() for p in ts_type.split("|")]
    parts = [p for p in parts if p != "null"]
    return " | ".join(parts) if parts else "null"


def render_object_body(
    schema: dict[str, Any], root_defs: dict[str, dict[str, Any]]
) -> str:
    """Render a ``type: object`` schema as a ``{ field: T; ... }`` block."""
    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    lines: list[str] = ["{"]
    for prop_name in props:
        prop_schema = props[prop_name]
        is_optional = prop_name not in required
        # Pydantic fields declared with ``Field(default_factory=list)`` or
        # ``Field(default_factory=dict)`` are absent from ``required`` but
        # the backend *always* serializes them (they default to an empty
        # collection, never to null — pydantic v2 invokes the factory at
        # validation time and emits the resulting value). Treat array
        # and object fields as required on the wire so call sites don't
        # have to handle a phantom ``undefined`` that the backend never
        # actually produces.
        if is_optional and prop_schema.get("type") in ("array", "object"):
            is_optional = False
        ts_type = schema_to_ts(prop_schema, root_defs)
        if is_optional:
            ts_type = strip_trailing_null(ts_type)
        description = prop_schema.get("description")
        if description:
            # Preserve model-level docstrings into JSDoc so IDE hovers
            # show the same text as the Python source.
            escaped = description.replace("*/", "*\\/")
            lines.append(f"  /** {escaped} */")
        marker = "?" if is_optional else ""
        lines.append(f"  {prop_name}{marker}: {ts_type};")
    lines.append("}")
    return "\n".join(lines)


def render_interface(
    name: str,
    schema: dict[str, Any],
    root_defs: dict[str, dict[str, Any]],
) -> str:
    """Emit one top-level ``export interface <Name> {...}`` block."""
    description = schema.get("description")
    header_lines: list[str] = []
    if description:
        header_lines.append("/**")
        for raw_line in description.strip().splitlines():
            header_lines.append(f" * {raw_line}".rstrip())
        header_lines.append(" */")
    body = render_object_body(schema, root_defs)
    return "\n".join(header_lines) + ("\n" if header_lines else "") + f"export interface {name} {body}"


def build_definitions_index() -> dict[str, dict[str, Any]]:
    """Gather every exported model's schema + their nested ``$defs``.

    Returns a ``{python_class_name: schema_node}`` map. Nested models
    show up once — pydantic inlines duplicates across sibling schemas.
    """
    index: dict[str, dict[str, Any]] = {}
    for model in EXPORTED_MODELS:
        schema = model.model_json_schema(mode="serialization")
        defs = schema.get("$defs", {})
        # The root schema itself — pydantic uses ``title`` for the class
        # name at the root level.
        root_name = schema.get("title") or model.__name__
        root_copy = {k: v for k, v in schema.items() if k != "$defs"}
        index.setdefault(root_name, root_copy)
        for def_name, def_schema in defs.items():
            index.setdefault(def_name, def_schema)
    return index


HEADER = """\
/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Produced from ``backend/api/models.py`` by
 * ``scripts/generate_ts_types.py``. Edit the pydantic models, then
 * re-run the script (``python scripts/generate_ts_types.py``) — the
 * frontend build runs it automatically via ``start.py``.
 */

/* eslint-disable */
"""


def generate() -> str:
    index = build_definitions_index()
    root_defs = index
    blocks: list[str] = []
    for python_name in sorted(index):
        schema = index[python_name]
        t = schema.get("type")
        if t == "object":
            blocks.append(render_interface(ts_name(python_name), schema, root_defs))
            continue
        if "enum" in schema:
            ts_alias = " | ".join(format_literal(v) for v in schema["enum"])
            blocks.append(f"export type {ts_name(python_name)} = {ts_alias};")
            continue
        # Anything else: emit a type alias (e.g. nested anyOf / $ref).
        blocks.append(
            f"export type {ts_name(python_name)} = {schema_to_ts(schema, root_defs)};"
        )
    return HEADER + "\n" + "\n\n".join(blocks) + "\n"


def main() -> int:
    out = generate()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = OUTPUT_PATH.read_text() if OUTPUT_PATH.exists() else ""
    if existing == out:
        print(f"generate_ts_types: no change ({OUTPUT_PATH.relative_to(REPO_ROOT)})")
        return 0
    OUTPUT_PATH.write_text(out)
    print(
        f"generate_ts_types: wrote {OUTPUT_PATH.relative_to(REPO_ROOT)} "
        f"({len(out.splitlines())} lines, {len(EXPORTED_MODELS)} models)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
