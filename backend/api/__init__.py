"""FastAPI routers + Pydantic wire-contract models.

The HTTP surface the SPA talks to. Route modules live under
[routers/](routers/) and are wired into the app from
[../server.py](../server.py); request/response shapes live in
[models.py](models.py). A few larger feature areas (settings, feedback)
expose ``mount(app, ...)`` helpers because they need extra shared state
at registration time.

UI connection
-------------
Page: ALL pages
UI element: indirect; every API call the SPA makes is served by a
            router defined under this package.
"""
