"""Pure risk-classification utilities.

Kept small and side-effect-free. The hot-path in :mod:`on_frame` imports
these. Extracted from ``server.py`` (step 7) so ``on_frame`` /
``episode_emit`` don't drag in the whole server module to reach them.
"""

from road_safety.core.detection import LOW_SPEED_FLOOR_MPS


async def _none_coro():
    """Trivial coroutine that yields ``None``.

    Used as a sentinel "no enrichment to run" task so the ``asyncio.gather``
    in ``emit_event`` always has two awaitables regardless of whether we
    actually called the LLM enrichment path.
    """
    return None


def pair_key(event_type: str, a, b) -> tuple | None:
    """Canonical pair key for an interaction. Returns None if either side has
    no track_id — in which case we fall back to type-level dedup.

    Args:
        event_type: The interaction category (e.g. ``"pedestrian_proximity"``).
        a, b: The two ``Detection`` objects in the interaction.

    Returns:
        ``(event_type, lo_track_id, hi_track_id)`` with the track-ids
        sorted so (A, B) and (B, A) map to the same episode. Returns
        ``None`` when either detection lacks a track id (object only
        appeared in a single frame) — caller falls back to a time-bucket
        key so we still dedup across a short window.
    """
    if a.track_id is None or b.track_id is None:
        return None
    lo, hi = sorted((a.track_id, b.track_id))
    return (event_type, lo, hi)


def classify_with_scene(
    ttc_sec,
    distance_m,
    fallback_px,
    thr,
    ego_speed_mps: float | None = None,
    any_track_approaching: bool = False,
) -> str:
    """Scene-adaptive risk classification with low-speed floor.

    Priority: TTC > distance > pixels. Highway widens TTC (more reaction
    time at speed); parking tightens it (close-quarters, slow).

    Low-speed floor: when ego is essentially stationary AND no track is
    actively approaching, risk is capped at 'medium'. Close-quarters
    proximity in stopped traffic is normal, not a conflict. A genuine
    approach by another moving object still upgrades the risk via
    `any_track_approaching`.

    Args:
        ttc_sec: Time-to-collision in seconds, or ``None`` if unknown.
        distance_m: 3D distance in metres, or ``None``.
        fallback_px: 2D pixel distance — used only when both of the
            above are unknown, as a last-resort proxy.
        thr: ``AdaptiveThresholds`` dataclass (scene-adapted: different
            numbers for urban vs highway vs parking).
        ego_speed_mps: Optical-flow-derived ego speed proxy, or ``None``
            when confidence is too low to trust.
        any_track_approaching: True if at least one track shows a
            positive ego-relative approach residual. Required to lift
            the low-speed floor.

    Returns:
        ``"low"`` / ``"medium"`` / ``"high"``. Never returns "unknown" —
        when all inputs are missing, defaults to "low".
    """
    levels = []
    if ttc_sec is not None:
        if ttc_sec <= thr.ttc_high_sec:
            levels.append("high")
        elif ttc_sec <= thr.ttc_med_sec:
            levels.append("medium")
    if distance_m is not None:
        if distance_m <= thr.dist_high_m:
            levels.append("high")
        elif distance_m <= thr.dist_med_m:
            levels.append("medium")
    if ttc_sec is None and distance_m is None:
        # Pixel fallback thresholds (60 / 180 px) are deliberately
        # conservative — only used when every other signal is missing.
        # They exist so a naive integration with no depth estimate at
        # all still produces something rather than silently swallowing
        # everything.
        if fallback_px <= 60:
            levels.append("high")
        elif fallback_px <= 180:
            levels.append("medium")

    # Highest tier wins across all priority levels.
    risk = "low"
    if "high" in levels:
        risk = "high"
    elif "medium" in levels:
        risk = "medium"

    # Speed-aware floor: in low-speed regimes (red light, traffic jam,
    # parking), close-quarters proximity is normal. Cap at medium unless
    # there is independent evidence of approach (ego-motion residual).
    # WHY this gate matters: without it, any stopped-at-a-light event with
    # a car within 2m was firing "high" — the single biggest source of
    # alert fatigue in early field tests.
    if (
        risk == "high"
        and ego_speed_mps is not None
        and ego_speed_mps < LOW_SPEED_FLOOR_MPS
        and not any_track_approaching
    ):
        return "medium"
    return risk
