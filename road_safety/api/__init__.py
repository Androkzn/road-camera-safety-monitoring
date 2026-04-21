"""api/__init__.py — package marker for HTTP route modules.

What it does:
    Marks ``road_safety/api/`` as a Python package. Having this file
    (even nearly empty) is what lets other code write
    ``from road_safety.api.feedback import mount``. Without it, Python
    would refuse to import anything inside the folder.

Purpose:
    Holds small, self-contained HTTP route groups that are "mounted"
    onto the main FastAPI application in ``server.py``. Splitting routes
    out of ``server.py`` keeps that file from growing without bound and
    makes each concern (feedback, coaching queue, future endpoints)
    easy to find and test in isolation.

How it works:
    FastAPI is the web framework this project uses. Each module in this
    package typically exposes a ``mount(app, ...)`` function that takes
    the main ``FastAPI`` object and registers its own routes on it. The
    main ``server.py`` calls those ``mount`` functions during startup,
    so by the time the HTTP server starts listening, every route module
    has attached its endpoints.

Connects to:
    - Backend: ``road_safety/server.py`` calls ``mount_feedback_routes(app)``
      (aliased from ``road_safety.api.feedback.mount``) during app setup.
    - UI: indirectly — the frontend ``frontend/src/lib/api.ts`` talks to
      the endpoints these modules expose (e.g. ``/api/feedback``,
      ``/api/coaching_queue``).
"""
