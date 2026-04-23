"""SSE fan-out helpers.

Each connected client has its own ``asyncio.Queue`` on ``state.subscribers``
or ``state.admin_detection_subscribers``. Broadcast = iterate the subscriber
set and ``put_nowait`` on each queue. ``QueueFull`` is swallowed so a single
slow consumer can't back-pressure the whole fan-out.

Two independent SSE channels live here:
    * ``state.subscribers`` — safety-event stream + control-plane
      perception-state pings. Consumed by the FE ``useEventStream`` /
      ``EventStreamProvider`` hook that drives Admin + Monitoring pages.
    * ``state.admin_detection_subscribers`` — per-frame detection
      snapshots used only by the Admin live-debug view (higher rate,
      smaller payloads, no storage).

Extracted from ``server.py`` (step 7).

UI connection
-------------
Page: [AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx) and
       [MonitoringPage.tsx](frontend/src/features/monitoring/MonitoringPage.tsx)
UI element: No direct UI — this is the pipe that pushes live updates to
       every browser tab that has a page open. Without it, the per-frame
       detection counts and quality banners on AdminPage and the
       new-incident cards on MonitoringPage would never appear in real
       time; the pages would only update on a manual refresh.
Data flow: Perception event or quality state -> broadcast_perception() /
       broadcast_admin_detections() puts message on each subscriber's
       queue -> SSE endpoint streams it to the browser -> consumed by
       the useEvents / useDetections hooks -> live tile + incident card
       updates on AdminPage and MonitoringPage.
"""

import asyncio

from backend.state import StreamSlot, state


async def broadcast_perception(qstate: dict, slot: StreamSlot | None = None) -> None:
    """Broadcast a perception-state change as a control-plane SSE message.

    Uses a sentinel ``_meta: "perception_state"`` so the UI can render a
    banner without confusing these with safety events. These are NOT
    persisted to the recent-events buffer — they are transient
    control-plane pings.

    Args:
        qstate: A dict from ``QualityMonitor.state()`` describing the new
            perception state (nominal / degraded / blind, plus reason text).
        slot: Source the change came from. Tagged onto the message so the
            UI can attribute the banner to the right stream.

    Side effects:
        Non-blocking ``put_nowait`` on every queue in
        ``state.subscribers``. A full queue is dropped silently — the
        FE resyncs state on the next safety event.
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

    Uses a separate subscriber set from the safety-event stream so a
    user who is only watching the Monitoring incident queue does not
    pay the per-frame broadcast cost.

    Args:
        msg: Pre-serialised snapshot built in ``on_frame`` — counts plus
            the list of object boxes for the current frame.

    Side effects:
        Non-blocking ``put_nowait`` on every queue in
        ``state.admin_detection_subscribers``. ``QueueFull`` is
        swallowed — dropped frames are acceptable for a debug view.
    """
    # Snapshot-iterate so a disconnect mid-fan-out doesn't raise.
    for q in list(state.admin_detection_subscribers):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            # Slow tab can't back-pressure the perception thread.
            pass
