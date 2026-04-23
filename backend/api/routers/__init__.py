"""Feature-sliced FastAPI ``APIRouter`` modules.

One file per UI surface — live, sources, admin_health, sse, watchdog,
settings (mounted separately), and so on. Each submodule exposes a
single ``router = APIRouter()`` that [../../server.py](../../server.py)
wires into the app with ``app.include_router(router)``. Behaviour,
paths, and auth are unchanged from the pre-split ``server.py`` — this
package is purely an organisational move.

UI connection
-------------
Page: ALL pages
UI element: indirect; the routers under this package serve every API
            call the SPA makes.
"""
