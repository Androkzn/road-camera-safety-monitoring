"""SSE fan-out helpers.

Each connected client has its own ``asyncio.Queue`` on ``state.subscribers``
or ``state.admin_detection_subscribers``. Broadcast = iterate the subscriber
set and ``put_nowait`` on each queue. ``QueueFull`` is swallowed so a single
slow consumer can't back-pressure the whole fan-out.

Extracted from ``server.py`` (step 7).
"""

import asyncio

from road_safety.state import StreamSlot, state


async def broadcast_perception(qstate: dict, slot: StreamSlot | None = None) -> None:
    """Broadcast a perception-state change as a control-plane SSE message.

    Uses a sentinel ``_meta: "perception_state"`` so the UI can render a
    banner without confusing these with safety events.

    Args:
        qstate: A dict from ``QualityMonitor.state()`` describing the new
            perception state (nominal / degraded / blind, plus reason text).
        slot: Source the change came from. Tagged onto the message so the
            UI can attribute the banner to the right stream.
    """
    # ``**qstate`` unpacks the dict into kwargs at literal-construction
    # time — merges the ``_meta`` tag with the fields.
    msg = {"_meta": "perception_state", **qstate}
    if slot is not None:
        msg["source_id"] = slot.source_id
        msg["source_name"] = slot.name
    # ``list(state.subscribers)`` snapshots the set so a concurrent
    # disconnect can't mutate what we're iterating over.
    for q in list(state.subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            # Dropping a message is preferable to blocking the broadcast
            # on one stuck subscriber. Client will resync on next event.
            pass


async def broadcast_admin_detections(msg: dict) -> None:
    """Fan out a per-frame detection snapshot to admin-dashboard SSE clients.

    Args:
        msg: Pre-serialised snapshot built in ``on_frame`` — counts plus
            the list of object boxes for the current frame.
    """
    for q in list(state.admin_detection_subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass
