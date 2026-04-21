"""Temporal de-duplication for conflict-detection events.

An :class:`Episode` aggregates consecutive frames that observe the *same*
pair of tracked objects into a single emitted safety event. Without this
layer the SSE feed would spew a hundred high-risk alerts for one near-miss.

The sustained-risk downgrade — peak risk demoted one level unless
supported by ≥2 frames over ≥1s — suppresses per-frame bbox-jitter spam
before it reaches the emit path.

Moved here from ``backend/state.py`` in the refactor that split domain
objects out of the state singleton. Behaviour is unchanged; only the
file location moved. The tunable constants travel with the class because
they are only meaningful as part of the sustained-risk logic.
"""

from __future__ import annotations


# ===== TUNABLE CONSTANTS =====
#
# A single high-risk frame in an otherwise calm episode is almost always
# a transient detection artefact; real conflicts produce ≥ 2 high-risk
# frames over ≥ 1 s of episode duration.
#
# Why these numbers: lowering ``MIN_HIGH_RISK_FRAMES`` below 2 lets bbox
# jitter spikes through as "high"; raising ``MIN_HIGH_RISK_EPISODE_SEC``
# above ~1s starts missing real short-lived collisions (motorbike cut-ins).
MIN_HIGH_RISK_FRAMES = 2
MIN_MEDIUM_RISK_FRAMES = 2
MIN_HIGH_RISK_EPISODE_SEC = 1.0


class Episode:
    """An ongoing interaction between a specific *pair* of tracked objects.

    The episode is held open while the pair stays in view, accumulating the
    worst risk and tightest distance across its lifetime, plus per-risk-level
    frame counts. On flush, the peak risk is **downgraded** if it lacks
    sustained support — a single high-risk frame is treated as a transient and
    reported as medium; a single medium frame becomes low.

    The episode model suppresses per-frame detection-artefact spam by
    requiring sustained evidence before promoting a peak risk into the
    emitted event.
    """

    def __init__(self, event_type: str, pair: tuple[int, int], started_at: float):
        """Initialise an empty episode for a specific (event_type, track-pair).

        Args:
            event_type: One of ``"pedestrian_proximity"`` /
                ``"vehicle_close_interaction"`` / etc. (see
                ``core/detection.py::find_interactions``).
            pair: Canonical ``(lo, hi)`` track-id pair as produced by
                ``_pair_key`` below.
            started_at: Wall-clock seconds (``time.time()``) when the pair
                was first observed. Doubles as the reference for the
                ``timestamp_sec`` field stamped onto the emitted event.

        State held:
            * ``peak_*``: snapshot of the worst frame seen so far (frame
              pixels, detections list, primary + secondary detection,
              distance_px, TTC, distance_m, risk label).
            * ``frame_count`` / ``risk_frame_counts``: per-risk tallies
              used by ``final_risk`` for the sustained-risk downgrade.
            * ``emitted``: one-shot guard — each episode emits at most
              one event regardless of how many flush attempts happen.
        """
        self.event_type = event_type
        self.pair = pair
        self.started_at = started_at
        self.last_seen_at = started_at
        # Orientation-policy decision cached on the episode so `_flush_episode`
        # can stamp SAE J3063 family + display-type overrides onto the emitted
        # event payload without re-running the gate at flush time. Populated
        # by the first frame that opens the episode (see the perception
        # pipeline); later
        # frames never overwrite it because a pair that started as BSW cannot
        # mid-episode become FCW without a new pair key.
        self.camera_orientation: str | None = None
        self.event_taxonomy: str = "FCW"
        self.display_event_type: str | None = None
        self.policy_reason: str | None = None
        self.peak_frame = None
        self.peak_detections: list = []
        self.peak_primary = None
        self.peak_secondary = None
        # ``float("inf")`` is a valid float that compares greater than any
        # finite number — used as an initial sentinel so the first real
        # measurement always wins the "tightest distance" check below.
        self.peak_distance_px: float = float("inf")
        self.peak_ttc: float | None = None
        self.peak_distance_m: float | None = None
        self.peak_risk: str = "low"
        self.frame_count: int = 0
        self.risk_frame_counts: dict[str, int] = {"low": 0, "medium": 0, "high": 0}
        self.emitted: bool = False

    def update(
        self,
        frame,
        detections,
        a,
        b,
        distance_px: float,
        ttc: float | None,
        dist_m: float | None,
        risk: str,
        now: float,
    ) -> None:
        """Fold one fresh frame observation into the rolling episode.

        Replaces the stored "peak" snapshot when the new frame is strictly
        worse than anything seen before — either a higher risk tier, or
        the same tier at a tighter pixel distance (tighter = more
        visually compelling thumbnail for review).

        Args:
            frame: Raw BGR numpy image from OpenCV. ``frame.copy()`` is
                held when it becomes the peak — we own an independent
                copy, the background reader is free to reuse its buffer.
            detections: List of ``Detection`` dataclasses for the whole
                frame (not just the interacting pair). The full list is
                stored so the redactor can draw bounding boxes around
                every visible object, not just the conflict participants.
            a, b: The two ``Detection`` objects that form this interaction.
            distance_px: 2D pixel distance between bbox centres — used as
                a last-resort distance proxy and as the peak tiebreaker.
            ttc: Time-to-collision in seconds, or ``None`` when unknown.
            dist_m: Estimated 3D separation in metres, or ``None``.
            risk: ``"low"`` / ``"medium"`` / ``"high"`` — already scene-
                adapted and low-speed-floored by the caller.
            now: Wall-clock timestamp for this observation.
        """
        self.last_seen_at = now
        self.frame_count += 1
        if risk in self.risk_frame_counts:
            self.risk_frame_counts[risk] += 1
        # ``risk_rank`` gives us an ordinal comparison on the string enum.
        # Keeping the mapping local to this method means we can't
        # accidentally mutate it from outside.
        risk_rank = {"low": 0, "medium": 1, "high": 2}
        is_new_peak = (
            risk_rank[risk] > risk_rank[self.peak_risk]
            or (risk == self.peak_risk and distance_px < self.peak_distance_px)
        )
        if is_new_peak or self.peak_frame is None:
            self.peak_frame = frame.copy()
            self.peak_detections = list(detections)
            self.peak_primary = a
            self.peak_secondary = b
            self.peak_distance_px = distance_px
            self.peak_ttc = ttc
            self.peak_distance_m = dist_m
            self.peak_risk = risk

    def final_risk(self) -> str:
        """Sustained-risk-aware downgrade.

        A peak risk only stands if supported by enough frames AND enough
        episode duration. Otherwise it is downgraded one level.

        Returns:
            ``"low"`` / ``"medium"`` / ``"high"``. The returned value may
            differ from ``self.peak_risk`` — ``_flush_episode`` records
            ``risk_demoted=True`` when this happens so reviewers can tell
            at a glance that the peak wasn't sustained.
        """
        # ``max(..., 0.0)`` guards against clock skew / reorderings that
        # could produce a negative duration and misleadingly pass the
        # threshold in either direction.
        duration = max(self.last_seen_at - self.started_at, 0.0)
        high = self.risk_frame_counts.get("high", 0)
        med = self.risk_frame_counts.get("medium", 0)

        if self.peak_risk == "high":
            if high >= MIN_HIGH_RISK_FRAMES and duration >= MIN_HIGH_RISK_EPISODE_SEC:
                return "high"
            # Demote to medium if the medium support is there, else low.
            # Rationale: a momentary TTC spike with no follow-through is
            # likely bbox jitter, not an actual near-miss.
            if (high + med) >= MIN_MEDIUM_RISK_FRAMES:
                return "medium"
            return "low"
        if self.peak_risk == "medium":
            if (high + med) >= MIN_MEDIUM_RISK_FRAMES:
                return "medium"
            return "low"
        return "low"
