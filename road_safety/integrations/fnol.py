"""FNOL (First Notice of Loss) payload shaping for insurer integrations.

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

Out of scope here:
    - Actual HTTP transport to an insurer (carriers use heterogeneous APIs;
      some still require email with an attached JSON).
    - MP4 clip export (the `clip_url` field accepts a placeholder until a
      rolling pre/post-roll buffer is wired up).
    - Chain-of-custody signing (insurers increasingly expect signed
      manifests; HMAC of this payload is already available via the
      edge_publisher path and can be reused here).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class FnolPayload:
    """Insurer-shaped view of a high-risk safety event.

    Field names are chosen to match common FNOL intake forms rather than
    the internal detection schema — this is a *translation*, not a
    restructuring. Downstream code and insurer adapters should read from
    this dataclass, not from the raw event dict.
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
        return asdict(self)


def build_fnol_payload(event: dict, *, operator_verified: bool = False) -> FnolPayload:
    """Translate an internal event dict into the insurer-shaped FNOL record.

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
    enrichment = event.get("enrichment") or {}

    # Counterparty: the "other" object in the interaction. We pick whichever
    # of `primary_obj` / `secondary_obj` is NOT our own vehicle class; fall
    # back to 'secondary' because by convention it's the object with which
    # the ego vehicle interacted.
    counterparty_type = (
        event.get("secondary_cls")
        or (event.get("objects") or [None, None])[-1]
    )

    ego_flow = event.get("ego_flow") or {}
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
