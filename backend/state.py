"""In-memory state for the live safety pipeline.

Holds the process-wide ``LiveState`` singleton shared by ``server.py``,
the perception thread, and every route handler:

    * :class:`LiveStateSnapshot` — frozen view used by route handlers.
    * :class:`LiveState`         — process-wide state container.
    * ``state``                  — module-level singleton instance.

The per-source domain objects (:class:`~backend.domain.episode.Episode`,
:class:`~backend.domain.stream_slot.StreamSlot`) moved to
``backend/domain/`` in the state-split refactor; this module still
re-exports them for backwards compatibility so existing
``from backend.state import Episode, StreamSlot`` imports keep working.

Camera-site identity (``RESOLVED_VEHICLE_ID`` / ``RESOLVED_ROAD_ID`` /
``RESOLVED_DRIVER_ID``) is resolved at import time so every emitted event
can attribute to a real camera site even when env vars are unset.

UI connection
-------------
Page: none directly.
UI element: No direct UI — shared in-memory state container. The most recent values it holds are what get returned to /api/live/status (top-bar uptime widget on every page).
"""

import asyncio
import socket
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from backend.config import (
    DEFAULT_STREAM_SOURCE as DEFAULT_SOURCE,
    DRIVER_ID,
    ROAD_ID,
    VEHICLE_ID,
)
from backend.core.stream import StreamReader
from backend.domain import (
    MIN_HIGH_RISK_EPISODE_SEC,
    MIN_HIGH_RISK_FRAMES,
    MIN_MEDIUM_RISK_FRAMES,
    Episode,
    StreamSlot,
)
from backend.integrations.edge_publisher import EdgePublisher
from backend.services.agents import AgentExecutor
from backend.services.drift import ActiveLearningSampler, DriftMonitor

# Re-export the domain classes + sustained-risk constants so existing
# ``from backend.state import Episode, StreamSlot, MIN_HIGH_RISK_FRAMES``
# imports keep working. The canonical home is ``backend.domain``; new
# code should import from there.
__all__ = [
    "Episode",
    "LiveState",
    "LiveStateSnapshot",
    "MIN_HIGH_RISK_EPISODE_SEC",
    "MIN_HIGH_RISK_FRAMES",
    "MIN_MEDIUM_RISK_FRAMES",
    "StreamSlot",
    "state",
]

if TYPE_CHECKING:
    from backend.core.validator import ValidatorWorker
    from backend.services.impact import ImpactMonitor
    from backend.services.ops_sampler import OpsSampler
    from backend.services.watchdog import Watchdog


# ===== SECTION: CAMERA-SITE IDENTITY RESOLUTION =====
# Events are meaningless to downstream analytics if they can't be attributed
# to a specific camera site / road / sensor. We resolve identity ONCE at
# import time; the results are frozen into module-level constants below and
# stamped onto every emitted event in ``_flush_episode``. In road-cam
# deployments the ``vehicle_id`` / ``driver_id`` fields are reused as
# camera-site / sensor attribution slots — their values are whatever the
# operator configures via env vars.


def _resolve_identity() -> tuple[str, str, str, list[str]]:
    """Return the effective camera-site identity for this process, plus any gaps.

    Reads ``VEHICLE_ID`` / ``ROAD_ID`` / ``DRIVER_ID`` (sourced from env in
    ``backend/config.py``). These identifiers are attribution slots —
    in a road-cam deployment their values are typically the camera-site
    vehicle / road / sensor IDs. If any is missing, substitutes a stable
    hostname-derived placeholder so events still emit — but also records
    the missing env-var names so ``lifespan`` can log a loud warning.

    Returns:
        A 4-tuple ``(vehicle_id, road_id, driver_id, missing_env_vars)``.
        ``missing_env_vars`` is the list of env var names that were empty
        (e.g. ``["ROAD_VEHICLE_ID"]``) — empty means fully configured.
    """
    host = socket.gethostname().split(".")[0] or "unknown"
    missing: list[str] = []
    vid = VEHICLE_ID
    rid = ROAD_ID
    did = DRIVER_ID
    if not vid:
        vid = f"unidentified_vehicle_{host}"
        missing.append("ROAD_VEHICLE_ID")
    if not rid:
        rid = f"unidentified_road_{host}"
        missing.append("ROAD_ID")
    if not did:
        did = f"unidentified_driver_{host}"
        missing.append("ROAD_DRIVER_ID")
    return vid, rid, did, missing


RESOLVED_VEHICLE_ID, RESOLVED_ROAD_ID, RESOLVED_DRIVER_ID, _MISSING_IDENTITY = (
    _resolve_identity()
)
# Note: tuple-unpacking a function result into multiple module-level
# constants is a common Python idiom. These values are frozen for the
# lifetime of the process; swapping identity mid-run would desync
# downstream cloud aggregation.


@dataclass(frozen=True)
class LiveStateSnapshot:
    """Immutable snapshot of ``LiveState`` at a single instant.

    Produced under ``state.lock`` so every field is consistent with every
    other field. Routes consume this instead of reading the live
    ``LiveState`` object (which the perception thread mutates
    concurrently). Paired with BE-D6 — this dataclass is the same shape
    the Pydantic response model will wrap.

    Fields:
        frames_read_total: Sum of ``reader.frames_read`` across all slots
            that have an active reader. Slots without a reader contribute
            ``0``.
        frames_processed_total: Same but for ``reader.frames_processed``.
        episodes_total: Sum of ``len(slot.episodes)`` across all slots.
        recent_events_count: ``len(state.recent_events)`` at snapshot time.
        recent_events: Shallow tuple copy of the recent-events list. The
            tuple is frozen but its dict elements remain mutable — routes
            MUST NOT mutate them; treat the contents as read-only.
        primary_source_id: The ``LiveState.PRIMARY_ID`` constant carried
            through for response shape clarity.
        sources: Tuple of per-slot ``status_dict()`` snapshots — one
            element per slot in ``state.slots``. Order is insertion
            order (matches Python 3.7+ dict iteration).
    """

    frames_read_total: int
    frames_processed_total: int
    episodes_total: int
    recent_events_count: int
    recent_events: tuple[dict, ...]
    primary_source_id: str
    sources: tuple[dict, ...]


class LiveState:
    """Process-wide in-memory state for the live safety pipeline.

    Holds the loaded YOLO model, the asyncio loop, every shared aggregator
    (recent events, SSE subscribers, drift monitor, edge publisher), and a
    registry of per-source ``StreamSlot``s.

    Backwards-compatibility: legacy code paths read fields like
    ``state.reader``, ``state.quality``, ``state.scene``, ``state.episodes``
    that used to be single-source. Those are now ``@property``s that
    delegate to the *primary* slot. Any new code should use
    ``state.slots[source_id]`` explicitly.

    Lifecycle:
        * Constructed at module import time with an empty primary slot
          (no reader yet) so attribute access during import doesn't NPE.
        * ``lifespan`` populates ``loop``, ``model``, builds the
          configured slots, starts each reader.
        * On shutdown, ``lifespan`` cancels background tasks and stops
          every slot's reader.
    """

    PRIMARY_ID = "primary"

    def __init__(self):
        self.model: Any = None
        self.source_label: str = DEFAULT_SOURCE
        self.loop: asyncio.AbstractEventLoop | None = None
        self.recent_events: list[dict] = []
        self.subscribers: set[asyncio.Queue] = set()
        self.event_counter = 0
        self.drift = DriftMonitor()
        self.active_learner = ActiveLearningSampler()
        self.edge_publisher = EdgePublisher()
        self.agent_executor: AgentExecutor | None = None
        self.watchdog: "Watchdog | None" = None
        self.admin_detection_subscribers: set[asyncio.Queue] = set()
        self.ops_sampler: "OpsSampler | None" = None
        self.settings_impact: "ImpactMonitor | None" = None
        self.settings_impact_subscribers: list[asyncio.Queue[Any]] = []
        # Background validator (dual-model shadow detector). Populated in
        # ``lifespan`` when ``VALIDATOR_ENABLED`` is true; ``None`` in dev
        # and single-model deployments.
        self.validator: "ValidatorWorker | None" = None
        # Source registry. Always contains at least the primary slot
        # (created here so legacy ``state.X`` proxies have a target to
        # delegate to). ``lifespan`` may rename / replace it once it
        # reads the configured sources.
        self.slots: dict[str, StreamSlot] = {
            self.PRIMARY_ID: StreamSlot(self.PRIMARY_ID, "Primary", DEFAULT_SOURCE),
        }
        # BE-D8: guards routes that read perception-thread state against
        # torn reads. ``_on_frame`` / ``_flush_episode`` briefly acquire
        # this lock around updates to ``recent_events`` and the per-slot
        # fields that ``snapshot()`` reads (via ``status_dict()``); route
        # handlers consume a frozen snapshot taken under the same lock so
        # every field is consistent with every other field. Held for a
        # microsecond — no contention expected with the perception thread.
        self.lock = threading.Lock()

    def snapshot(self) -> LiveStateSnapshot:
        """Return a frozen, consistent view of this ``LiveState``.

        Acquires ``self.lock`` once, reads every field the public /
        admin routes need, and returns a frozen dataclass. Routes MUST
        call this instead of reading the live ``state.*`` attributes —
        the perception thread can be mid-update to any of them.

        The per-slot ``status_dict()`` calls happen inside the lock so
        frame counts, uptime, and perception state stay mutually
        consistent. Expensive work is intentionally kept OUT of the
        locked region (routes do their own formatting afterwards).
        """
        with self.lock:
            frames_r = 0
            frames_p = 0
            episodes = 0
            sources: list[dict] = []
            for _sid, slot in self.slots.items():
                reader = slot.reader
                if reader is not None:
                    frames_r += int(getattr(reader, "frames_read", 0) or 0)
                    frames_p += int(getattr(reader, "frames_processed", 0) or 0)
                episodes += len(slot.episodes)
                sources.append(slot.status_dict())
            return LiveStateSnapshot(
                frames_read_total=frames_r,
                frames_processed_total=frames_p,
                episodes_total=episodes,
                recent_events_count=len(self.recent_events),
                # Shallow copy: the tuple is frozen but its dict refs are
                # the same objects in the live buffer. Routes must treat
                # the dicts as read-only; mutating them races with the
                # perception thread.
                recent_events=tuple(self.recent_events),
                primary_source_id=self.PRIMARY_ID,
                sources=tuple(sources),
            )

    def recent_events_snapshot(self, limit: int | None = None) -> list[dict]:
        """Return a copy of recent events under ``state.lock``.

        Args:
            limit: Optional tail-length cap. ``None`` returns the full buffer.
        """
        with self.lock:
            if limit is None:
                return list(self.recent_events)
            if limit <= 0:
                return []
            return list(self.recent_events[-limit:])

    def append_recent_event(self, event: dict, max_items: int) -> None:
        """Append one event and enforce max buffer size atomically."""
        with self.lock:
            self.recent_events.append(event)
            overflow = len(self.recent_events) - max_items
            if overflow > 0:
                del self.recent_events[:overflow]

    def clear_recent_events(self) -> int:
        """Clear and return the number of removed buffered events."""
        with self.lock:
            cleared = len(self.recent_events)
            self.recent_events.clear()
            return cleared

    def find_recent_event(self, event_id: str) -> dict | None:
        """Find one event by id from newest to oldest under lock."""
        with self.lock:
            for ev in reversed(self.recent_events):
                if ev.get("event_id") == event_id:
                    return ev
        return None

    # ----- Per-slot proxies (legacy single-source accessors) -----
    # Every read here delegates to the primary slot. Writes that mutate
    # objects in place (``state.episodes[key] = ...``) work because the
    # property returns the live dict reference.
    @property
    def primary_slot(self) -> StreamSlot:
        slot = self.slots.get(self.PRIMARY_ID)
        if slot is not None:
            return slot
        if self.slots:
            # ``primary`` was removed but other slots remain — pick any so
            # legacy ``state.X`` access has a target.
            return next(iter(self.slots.values()))
        # Registry is empty (operator removed every slot). Re-create an
        # empty placeholder so legacy property accesses keep working.
        placeholder = StreamSlot(self.PRIMARY_ID, "Primary", DEFAULT_SOURCE)
        self.slots[self.PRIMARY_ID] = placeholder
        return placeholder

    @property
    def reader(self) -> StreamReader | None:
        return self.primary_slot.reader

    @reader.setter
    def reader(self, v):
        self.primary_slot.reader = v

    @property
    def track_history(self):
        return self.primary_slot.track_history

    @property
    def episodes(self):
        return self.primary_slot.episodes

    @property
    def pair_cooldown(self):
        return self.primary_slot.pair_cooldown

    @property
    def quality(self):
        return self.primary_slot.quality

    @property
    def last_perception_state(self):
        return self.primary_slot.last_perception_state

    @last_perception_state.setter
    def last_perception_state(self, v):
        self.primary_slot.last_perception_state = v

    @property
    def ego(self):
        return self.primary_slot.ego

    @property
    def scene(self):
        return self.primary_slot.scene

    @property
    def last_ego_flow(self):
        return self.primary_slot.last_ego_flow

    @last_ego_flow.setter
    def last_ego_flow(self, v):
        self.primary_slot.last_ego_flow = v

    @property
    def last_scene_ctx(self):
        return self.primary_slot.last_scene_ctx

    @last_scene_ctx.setter
    def last_scene_ctx(self, v):
        self.primary_slot.last_scene_ctx = v

    @property
    def _frame_lock(self):
        return self.primary_slot._frame_lock

    @property
    def _annotated_jpeg(self):
        return self.primary_slot._annotated_jpeg

    @_annotated_jpeg.setter
    def _annotated_jpeg(self, v):
        self.primary_slot._annotated_jpeg = v

    @property
    def _frame_detections(self):
        return self.primary_slot._frame_detections

    @_frame_detections.setter
    def _frame_detections(self, v):
        self.primary_slot._frame_detections = v

    @property
    def _frame_ts(self):
        return self.primary_slot._frame_ts

    @_frame_ts.setter
    def _frame_ts(self, v):
        self.primary_slot._frame_ts = v


# Module-level singleton. Import-time construction is safe because
# ``LiveState.__init__`` only builds default-constructed helpers.
state = LiveState()
