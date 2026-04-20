"""HTTP API route modules.

This package groups FastAPI route modules that are wired into the main
application from ``backend.server``. The server file is the composition
root; feature endpoints live here (plus the settings and feedback mounts)
so they can evolve and be tested independently.

Most modules in this package expose a single ``router = APIRouter()``
object. A few larger feature areas, such as settings and feedback, expose
``mount(app, ...)`` helpers because they need extra shared callbacks or
state at registration time.
"""
