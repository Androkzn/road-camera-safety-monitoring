"""FNOL (First Notice of Loss) payload shaping for insurer integrations.

INTEGRATION STATUS: STUB — wire up before production use.
-------------------------------------------------------
This module produces the *shape* of a FNOL record but does NOT transmit
it. There is no carrier-specific adapter, no HTTP client, no signed
manifest upload. Consider this the in-house data model; the transport
layer is deliberately deferred until a real insurer partnership lands.

Why this module exists
----------------------
Insurance is the dominant commercial driver behind fleet dashcam adoption.
When a collision happens, the fleet's insurer expects a structured first-
notice-of-loss record — not a video file in isolation, not a JSON blob of
detection internals. The shape that reduces claim-handling time is well
known across carriers (Travelers, Nationwide, Progressive commercial,
specialty markets):

    - when + where (ISO timestamp + GPS)
    - who (policy holder → vehicle_id → driver_id)
    - what (severity, TTC, classified event type, other road users involved)
    - evidence pointer (clip URL, thumbnail URL, hashed plate of counterparty)
    - kinematics (speed + g-force peaks if available)
    - operator-verified flag (has a human reviewed this, or is it still AI-only?)

We do NOT send this payload anywhere automatically — that's a deliberate
policy choice. Auto-transmitting every high-risk event to an insurer would
leak raw detection noise into underwriting data and would violate most
carriers' FNOL SLAs (which expect human triage first). Instead, this
module produces the shaped record so an operator-driven "Submit to
insurer" action or a batched end-of-day export can ship it cleanly.

Out of scope here (the stub parts)
----------------------------------
    - Actual HTTP transport to an insurer (carriers use heterogeneous APIs;
      some still require email with an attached JSON).
    - MP4 clip export (the ``clip_url`` field accepts a placeholder until
      a rolling pre/post-roll buffer is wired up).
    - Chain-of-custody signing (insurers increasingly expect signed
      manifests; HMAC of this payload is already available via the
      ``edge_publisher`` path and can be reused here).

PRIVACY NOTE: the counterparty plate identifier here is ONLY the salted
SHA-256 hash — never the raw plate string. Insurers can still do cross-
event correlation on the hash (same salt ⇒ same input ⇒ same hash) without
ever seeing a plate in cleartext.

Files this module reads / writes
--------------------------------
None. This is a pure data-shaping module: input dict in, dataclass out.

Environment variables
---------------------
None. Config for a future transport layer would live on the carrier
adapter, not here.
"""

# ``from __future__ import annotations`` — see ``edge_publisher.py`` for
# the full explanation. Short version: makes ``str | None`` etc. work on
# older Python versions.
from __future__ import annotations

# Standard library only — this module is intentionally self-contained so
# that the insurer-facing data shape is not coupled to any networking or
# config concerns.
from dataclasses import asdict, dataclass
from typing import Any


# ``@dataclass`` is a decorator. In Python, a decorator (``@name``) is a
# function that transforms the class or function defined immediately below
# it. ``@dataclass`` in particular synthesizes ``__init__``, ``__repr__``,
# and ``__eq__`` from the class body's typed attributes — so we get a
# well-behaved value object without boilerplate.
@dataclass
class FnolPayload:
    """Insurer-shaped view of a high-risk safety event.

    Field names are chosen to match common FNOL intake forms rather than
    the internal detection schema — this is a *translation*, not a
    restructuring. Downstream code and insurer adapters should read from
    this dataclass, not from the raw event dict.

    Each attribute below has its type annotation AND a trailing comment
    describing its provenance / semantics. The ``| None`` suffix means
    "may be None when we don't have a value" — e.g. TTC and distance are
    not always computable (tracker lost, single-object scene, etc.).
    """

    event_id: str
    occurred_at: str           # ISO-8601 UTC
    vehicle_id: str
    driver_id: str
    road_id: str
    location: str              # free-form for now; upgrade to {lat,lng} when GPS lands
    severity: str              # "high" | "medium" | "low" — maps to insurer "severity"
    event_type: str            # pedestrian_proximity | vehicle_close_interaction | ...
    summary: str               # one-sentence human narration (if available)
    ttc_sec: float | None      # sub-second = imminent; NHTSA/SAFE-UP definition
    distance_m: float | None   # closest approach in metres
    speed_mps: float | None    # ego speed (from telematics if available, proxy otherwise)
    speed_source: str          # "gps" | "optical_flow_proxy" | "unknown"
    counterparty_plate_hash: str | None  # salted SHA-256 only — never the raw plate
    counterparty_type: str | None        # "car" | "pedestrian" | etc.
    thumbnail_url: str | None  # redacted public thumbnail
    clip_url: str | None       # placeholder until MP4 pre/post-roll is wired
    operator_verified: bool    # has a human reviewed + confirmed this event?
    evidence_hash: str | None  # SHA-256 of the thumbnail for chain-of-custody

    def to_dict(self) -> dict[str, Any]:
        """Return a plain-dict view for JSON serialization / logging.

        ``dataclasses.asdict`` recursively converts dataclass instances into
        dicts. The returned dict is safe to ``json.dumps`` and safe to
        hand to an insurer adapter without further munging.
        """
        return asdict(self)


def build_fnol_payload(event: dict, *, operator_verified: bool = False) -> FnolPayload:
    """Translate an internal event dict into the insurer-shaped FNOL record.

    Args:
        event: internal event dict as produced by the perception pipeline.
            Must have already been redacted (``enrichment.plate_hash`` set,
            no raw plate fields).
        operator_verified: whether a human has reviewed this event in the
            ops UI. Passed as a keyword-only argument (the ``*`` in the
            signature forbids positional passing) so call sites read as
            ``build_fnol_payload(evt, operator_verified=True)`` and the
            boolean is never ambiguous.

    Returns:
        A fully-populated ``FnolPayload``. Missing fields in the input
        collapse to sensible defaults (empty string / None) rather than
        raising, so the caller can route the payload to an operator UI
        even if the upstream pipeline was incomplete.

    Design notes:
      - Speed source is reported honestly: "optical_flow_proxy" when the
        value comes from the ego-motion estimator, "gps" when a real
        telematics feed is wired in, "unknown" when neither is present.
        Underwriters rely on this field to weight the record.
      - Plate hashes are carried through verbatim — they are already salted
        and irreversible, and cross-event correlation is one of the things
        the insurer cares about ("have we seen this counterparty before?").
      - No GPS lat/lng yet — LOCATION is a free-form string from config.
        Upgrade path: when a GPS shim lands, extend location to
        {'text': ..., 'lat': ..., 'lng': ..., 'accuracy_m': ...}.
    """
    # ``dict.get(k) or {}`` — defensive default. If the event is missing
    # "enrichment" OR has it set to None, we get an empty dict to traverse.
    enrichment = event.get("enrichment") or {}

    # Counterparty: the "other" object in the interaction. We pick whichever
    # of `primary_obj` / `secondary_obj` is NOT our own vehicle class; fall
    # back to 'secondary' because by convention it's the object with which
    # the ego vehicle interacted. ``(list or [None, None])[-1]`` gives us
    # the last element of the objects list, or None if it's missing.
    counterparty_type = (
        event.get("secondary_cls")
        or (event.get("objects") or [None, None])[-1]
    )

    ego_flow = event.get("ego_flow") or {}
    # ``isinstance(x, dict)`` is the defensive type guard — an event that
    # came off the wire could in theory have any type for ``ego_flow``.
    speed_mps = ego_flow.get("speed_proxy_mps") if isinstance(ego_flow, dict) else None
    # If a GPS speed field ever lands (event["gps"]["speed_mps"]) prefer it.
    gps = event.get("gps") or {}
    if isinstance(gps, dict) and gps.get("speed_mps") is not None:
        speed_mps = gps.get("speed_mps")
        speed_source = "gps"
    elif speed_mps is not None:
        speed_source = "optical_flow_proxy"
    else:
        speed_source = "unknown"

    return FnolPayload(
        event_id=event.get("event_id", ""),
        occurred_at=event.get("timestamp", ""),
        vehicle_id=event.get("vehicle_id", ""),
        driver_id=event.get("driver_id", ""),
        road_id=event.get("road_id", ""),
        location=event.get("location", ""),
        severity=event.get("risk_level", "unknown"),
        event_type=event.get("event_type", "unknown"),
        summary=event.get("narration") or event.get("summary", ""),
        ttc_sec=event.get("ttc_sec"),
        distance_m=event.get("distance_m"),
        speed_mps=speed_mps,
        speed_source=speed_source,
        # Salted SHA-256 only — even the insurer never sees a raw plate.
        counterparty_plate_hash=enrichment.get("plate_hash"),
        counterparty_type=counterparty_type,
        thumbnail_url=event.get("thumbnail_public") or event.get("thumbnail_url"),
        clip_url=event.get("clip_url"),  # None until MP4 export lands
        operator_verified=operator_verified,
        evidence_hash=event.get("evidence_hash"),
    )


def is_fnol_candidate(event: dict) -> bool:
    """Gate for which events should surface in the FNOL review queue.

    Not every detected event belongs in an insurance workflow. We surface
    only high-risk, sustained-episode events — exactly the ones the
    downstream Slack immediate-alert gate also passes. Medium/low events
    belong in driver coaching, not claim files.

    Returns:
        True iff the event is both (a) high risk and (b) exhibits the
        kinematic signature of an actual near-miss (sub-second TTC or
        sub-2m minimum distance). The 1.0s TTC and 2.0m distance are
        deliberately tight: looser thresholds fill the queue with noise
        and defeat the purpose of the gate.
    """
    if event.get("risk_level") != "high":
        return False
    # Require either a sub-second TTC or a sub-2m distance — the kinematic
    # signature of an actual near-miss. Events without either are unlikely
    # to survive insurer review.
    ttc = event.get("ttc_sec")
    dist = event.get("distance_m")
    if ttc is not None and ttc <= 1.0:
        return True
    if dist is not None and dist <= 2.0:
        return True
    return False
