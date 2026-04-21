"""Compose the FastAPI edge server application.

This module is intentionally small. It owns only:

* configuring process-wide logging
* creating the FastAPI app with the shared lifespan hook
* mounting feature routers and static assets
* wiring the feedback and settings route mounts

It should stay the composition root for the edge server and nothing more.
"""

from __future__ import annotations

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
from backend.startup import lifespan

setup_logging()


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
    """Attach the extracted feature routers to ``app``."""
    for router in _FEATURE_ROUTERS:
        app.include_router(router)


def create_app() -> FastAPI:
    """Build and return the FastAPI edge server application."""
    app = FastAPI(title="Live Safety Review", lifespan=lifespan)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    _include_feature_routers(app)
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
    mount_feedback_routes(app, on_feedback=_on_feedback, event_lookup=_find_event)
    mount_settings_routes(app)
    return app


app = create_app()

__all__ = ["app", "create_app"]
