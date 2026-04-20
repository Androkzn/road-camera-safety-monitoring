"""SPA page passthroughs + legacy batch-summary route.

All SPA pages serve the same React ``index.html``; the browser-side
router picks the actual page. Each route exists so server-side URL
rewrites and deep links resolve.
"""

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.config import DATA_DIR, STATIC_DIR

router = APIRouter()


def _load_batch(name: str):
    """Read a batch-pipeline JSON artefact from DATA_DIR or raise 404.

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
    """Serve the SPA index.html.

    HTTP: GET /
    AUTH: public
    Returns:
        The built ``index.html`` (React app entrypoint).
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/favicon.ico")
def favicon():
    """Serve the favicon if present, else 404.

    HTTP: GET /favicon.ico
    AUTH: public
    """
    path = STATIC_DIR / "favicon.ico"
    if path.exists():
        return FileResponse(path)
    raise HTTPException(404)


@router.get("/admin")
def admin_page():
    """Serve the admin SPA page.

    HTTP: GET /admin
    AUTH: public (page shell only; data endpoints enforce their own auth)
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/dashboard")
def dashboard_page():
    """Serve the dashboard SPA page.

    HTTP: GET /dashboard
    AUTH: public
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/monitoring")
def monitoring_page():
    """Serve the monitoring (watchdog incident queue) SPA page.

    HTTP: GET /monitoring
    AUTH: public
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/settings")
def settings_page():
    """Serve the Settings Console SPA shell.

    HTTP: GET /settings
    AUTH: public (page shell only; every ``/api/settings/*`` data endpoint
                  is admin-bearer gated and the SPA prompts for the token).
    """
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/api/summary")
def summary():
    """Serve the offline batch summary JSON produced by ``analyze.py``.

    HTTP: GET /api/summary
    AUTH: public
    Raises: 404 if ``summary.json`` has not been produced yet.
    """
    return _load_batch("summary.json")
