"""Serve the built React SPA + SPA-fallback catch-all.

Mounts `/assets/*` as static files from the built Vite bundle, serves
`index.html` at `/`, and returns `index.html` for every unknown URL so
React Router can handle client-side routing. Also owns small utility
endpoints like `/favicon.ico` and the app shell health ping.

UI connection
-------------
Page: ALL pages (this is the file that actually serves the HTML and JS
bundle that renders every page).
UI element: None directly — this is the plumbing that delivers the React
bundle to the browser. Without this router, the SPA would 404 on a deep
link like /settings or /monitoring.
Backend route(s): GET /, GET /assets/*, GET /{catch-all} (SPA fallback).
"""

import json

# ``APIRouter`` is FastAPI's way of grouping routes under a common prefix
# / tag. ``HTTPException`` raises a structured HTTP error response.
# ``FileResponse`` streams a file from disk with correct Content-Type.
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.config import DATA_DIR, STATIC_DIR

# One router per feature — ``server.py`` mounts this one for SPA shells.
router = APIRouter()


def _load_batch(name: str):
    """Read a batch-pipeline JSON artefact from DATA_DIR or raise 404.

    Helper (leading underscore = private, not exported). Reads a JSON
    file from the server's data directory and parses it into a Python
    dict so FastAPI can serialise it back out. Raises ``HTTPException``
    with status 404 if the file is not on disk — FastAPI turns that
    into an HTTP 404 response automatically.

    Used by the legacy ``/api/summary`` endpoint to serve files written
    by the offline ``analyze.py`` script. Live endpoints should read
    ``state.recent_events`` directly instead.
    """
    path = DATA_DIR / name
    if not path.exists():
        raise HTTPException(404, f"{name} not found — run analyze.py first")
    return json.loads(path.read_text())


@router.get("/")
def index():
    """Serve the built React ``index.html`` at the site root.

    The ``@router.get("/")`` line above is a decorator — it registers
    this function as the handler FastAPI calls when a browser requests
    ``GET /``. ``FileResponse`` streams the file to the client with the
    right Content-Type header.

    HTTP: GET /
    AUTH: public
    Returns: the built ``index.html`` (React app entrypoint). The JS
        bundle linked from that HTML then boots the SPA.
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/favicon.ico")
def favicon():
    """Serve the favicon (browser tab icon) if present, else 404.

    Browsers request ``/favicon.ico`` automatically on every page; if
    the file has not been built yet we return 404 rather than the SPA
    shell so the browser stops asking.

    HTTP: GET /favicon.ico
    AUTH: public
    """
    path = STATIC_DIR / "favicon.ico"
    if path.exists():
        return FileResponse(path)
    raise HTTPException(404)


@router.get("/admin")
def admin_page():
    """Serve the admin SPA page shell (the browser-side router does the rest).

    Returns the SAME ``index.html`` as ``/`` — there is only one HTML
    file in an SPA. The React Router running inside the bundle reads
    the URL and mounts the AdminPage component. This server route
    exists only so a deep link like ``https://host/admin`` does not
    404 on page refresh.

    HTTP: GET /admin
    AUTH: public (page shell only; data endpoints enforce their own auth)
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/dashboard")
def dashboard_page():
    """Serve the dashboard SPA page shell.

    Same HTML as ``/``; React Router picks the DashboardPage component
    based on the URL. This route exists so refreshing on ``/dashboard``
    does not 404.

    HTTP: GET /dashboard
    AUTH: public
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/monitoring")
def monitoring_page():
    """Serve the monitoring (watchdog incident queue) SPA page shell.

    Same HTML as ``/``; React Router mounts the MonitoringPage
    component. Route exists so deep links and refreshes on
    ``/monitoring`` do not 404.

    HTTP: GET /monitoring
    AUTH: public
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/settings")
def settings_page():
    """Serve the Settings Console SPA page shell.

    Same HTML as ``/``; React Router mounts the SettingsPage component.
    The page shell itself is public — but the data-fetching API routes
    the settings page calls (``/api/settings/*``) require an admin
    bearer token, and the SPA prompts the user for it.

    HTTP: GET /settings
    AUTH: public (page shell only; every ``/api/settings/*`` data endpoint
                  is admin-bearer gated and the SPA prompts for the token).
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/api/summary")
def summary():
    """Serve the offline batch summary JSON produced by ``analyze.py``.

    Legacy endpoint. Reads ``summary.json`` off disk via ``_load_batch``
    and returns it as JSON. FastAPI auto-converts the returned dict
    into a JSON response.

    HTTP: GET /api/summary
    AUTH: public
    Raises: 404 if ``summary.json`` has not been produced yet (run
        ``analyze.py`` first).
    """
    return _load_batch("summary.json")
