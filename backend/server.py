"""Compose the FastAPI edge server application.

This module is intentionally small. It owns only:

* configuring process-wide logging
* creating the FastAPI app with the shared lifespan hook
* mounting feature routers and static assets
* wiring the feedback and settings route mounts

It should stay the composition root for the edge server and nothing more.

Python / FastAPI primer for this file
-------------------------------------
* ``FastAPI`` is a web framework: you create an ``app`` object, attach
  routes to it (via ``app.include_router(...)``), and hand the app to an
  ASGI server (``uvicorn``) that turns incoming HTTP requests into calls
  against your route handlers.
* ``lifespan`` is FastAPI's startup+shutdown hook: an async context manager
  whose pre-yield body runs at boot and post-yield body runs at shutdown.
  See ``backend/startup.py::lifespan`` for the full orchestration.
* ``StaticFiles`` is a FastAPI helper that serves a directory of raw files
  (the built React bundle) at a URL prefix — no Python code involved.

UI connection
-------------
Page: ALL pages.
UI element: The whole web UI is hosted from this file. It mounts every API router, serves the built React app, and runs the background workers that feed live data to the frontend.
"""

# ``from __future__ import annotations`` changes how Python handles type
# hints: they are treated as plain strings rather than being evaluated at
# function-definition time. That lets us use newer syntax like
# ``str | None`` and forward references regardless of interpreter version.
from __future__ import annotations

# Standard-library asyncio — unused in the visible body but kept imported
# because older tooling in the codebase relies on its presence here.
import asyncio

# ``FastAPI`` is the web-app class; ``StaticFiles`` mounts a directory of
# static assets (our built React bundle) under a URL prefix.
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.api.feedback import mount as mount_feedback_routes
from backend.api.routers import (
    active_learning as router_active_learning,
    admin_health as router_admin_health,
    admin_video as router_admin_video,
    agents as router_agents,
    audit as router_audit,
    live as router_live,
    llm_obs as router_llm_obs,
    retention as router_retention,
    road as router_road,
    sources as router_sources,
    spa as router_spa,
    sse as router_sse,
    tests as router_tests,
    thumbnails as router_thumbnails,
    watchdog as router_watchdog,
)
from backend.api.settings import mount as mount_settings_routes
from backend.config import STATIC_DIR, THUMBS_DIR
from backend.logging import setup as setup_logging
from backend.perception.emit import find_event as _find_event, on_feedback as _on_feedback
from backend.services.impact import ImpactMonitor as SettingsImpactMonitor
from backend.services.llm_obs import observer as llm_observer
from backend.services.ops_sampler import OpsSampler
from backend.startup import lifespan
from backend.state import state

# Configure process-wide structured logging BEFORE any other code has a
# chance to emit log records — otherwise early boot lines would print with
# the default format and be invisible to the JSON-line aggregator.
setup_logging()


# Tuple of every feature router the edge app exposes. Each router is a
# ``fastapi.APIRouter`` with its own prefix (e.g. ``/api/live``); grouping
# them here lets ``create_app`` iterate and mount in one place.
_FEATURE_ROUTERS = (
    router_audit.router,
    router_retention.router,
    router_llm_obs.router,
    router_road.router,
    router_agents.router,
    router_tests.router,
    router_active_learning.router,
    router_spa.router,
    router_thumbnails.router,
    router_sse.router,
    router_admin_health.router,
    router_admin_video.router,
    router_live.router,
    router_watchdog.router,
    router_sources.router,
)


def _include_feature_routers(app: FastAPI) -> None:
    """Attach the extracted feature routers to ``app``.

    Iterates the ``_FEATURE_ROUTERS`` tuple and calls
    ``app.include_router(r)`` on each. ``include_router`` copies every
    route the router declares onto the app under its prefix — this is
    FastAPI's standard composition pattern.
    """
    # ``for router in _FEATURE_ROUTERS:`` iterates the tuple in order.
    # Order does not matter here because each router has its own prefix.
    for router in _FEATURE_ROUTERS:
        app.include_router(router)


def _aggregate_frames() -> tuple[int, int]:
    """Sum ``frames_read`` / ``frames_processed`` across all active slots.

    Returns a plain 2-tuple ``(read, processed)``. ``tuple[int, int]`` is
    a type hint — it describes the shape to readers and static analysers
    but does not enforce anything at runtime.
    """
    total_read = 0
    total_proc = 0
    # ``state.slots`` is a dict of {source_id: StreamSlot}; ``.values()``
    # gives an iterable view over the slot objects.
    for slot in state.slots.values():
        reader = slot.reader
        if reader is not None:
            # ``getattr(obj, "attr", default)`` reads an attribute safely,
            # returning the default if the attribute is missing. The ``or 0``
            # covers the case where the attribute exists but is ``None``.
            total_read += int(getattr(reader, "frames_read", 0) or 0)
            total_proc += int(getattr(reader, "frames_processed", 0) or 0)
    return total_read, total_proc


def _configure_settings_console(app: FastAPI) -> None:
    """Wire the settings console and its shared monitors onto ``app``.

    Builds the two runtime-stats monitors (``OpsSampler``,
    ``ImpactMonitor``), stashes them on the global ``state`` so other code
    can read them, and mounts the settings API routes that expose them.
    """
    # OpsSampler periodically snapshots frame counters + LLM stats so the
    # settings UI can show "before / after" metrics around a change.
    state.ops_sampler = OpsSampler(
        frames_source=_aggregate_frames,
        llm_stats_fn=llm_observer.stats,
    )
    # ImpactMonitor watches the recent-events buffer + ops stats so the UI
    # can surface whether a settings change actually moved the needle.
    state.settings_impact = SettingsImpactMonitor(
        events_source=state.recent_events_snapshot,
        ops_stats_fn=state.ops_sampler.window_stats,
    )
    state.settings_impact_subscribers = []
    mount_settings_routes(
        app,
        impact_monitor=state.settings_impact,
        impact_subscribers=state.settings_impact_subscribers,
    )


def create_app() -> FastAPI:
    """Build and return the FastAPI edge server application.

    Factory function so tests can spin up a fresh app without importing
    the module-level ``app`` singleton. ``title=`` shows up in the
    auto-generated OpenAPI docs; ``lifespan=`` hands FastAPI the
    startup/shutdown async context manager from ``backend/startup.py``.
    """
    app = FastAPI(title="Live Safety Review", lifespan=lifespan)
    # ``Path.mkdir(parents=True, exist_ok=True)`` creates every missing
    # directory on the path; ``exist_ok=True`` makes it a no-op if the
    # directory already exists (instead of raising FileExistsError).
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    _include_feature_routers(app)
    # Serve the built React bundle's /assets/ under the /assets URL. The
    # ``name=`` is used by FastAPI's URL-reversing helpers.
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
    # Feedback routes need callbacks into the perception layer (to record a
    # verdict + resolve an event by id). Passing them in at mount time
    # keeps the router module free of circular imports.
    mount_feedback_routes(app, on_feedback=_on_feedback, event_lookup=_find_event)
    _configure_settings_console(app)
    return app


# Module-level singleton used by uvicorn: `uvicorn backend.server:app`.
app = create_app()

# ``__all__`` controls what ``from backend.server import *`` exposes.
# Listed here for explicit documentation; not strictly required.
__all__ = ["app", "create_app"]
