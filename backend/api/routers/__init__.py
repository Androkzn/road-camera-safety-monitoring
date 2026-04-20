"""Feature routers mounted into the edge-server FastAPI app.

Each submodule exposes a single ``router = APIRouter()`` that
``backend.server`` wires into the app with ``app.include_router(router)``.
Behaviour / paths / auth unchanged — this package is purely an organisational
move of the old ``@app.get(...)`` / ``@app.post(...)`` handlers out of
``server.py``.
"""
