"""Thumbnail serving (fully open POC).

Serves event thumbnails on disk. Every access is audit-logged so a
reviewer can reconstruct who viewed which redacted image. The POC has
no authentication — production deployments must gate this behind a
real auth layer before exposing publicly.

UI connection
-------------
Page: DashboardPage + AdminPage + MonitoringPage + ValidationPage —
       [file](frontend/src/shared/events/EventCard.tsx)
UI element: the small redacted preview image on every event card across
all pages, and the larger image inside the event-detail dialog.
Backend route(s): GET /thumbnails/{name}.
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from backend.compliance import audit
from backend.config import THUMBS_DIR

# ``APIRouter`` — single-handler grouping.
router = APIRouter()


# ``Request`` is FastAPI's wrapper around the raw HTTP request — used
# here to read the client IP for the audit log. The ``{name}`` path
# segment is bound to the ``name`` argument automatically.
@router.get("/thumbnails/{name}")
def thumbnail(name: str, request: Request):
    """Serve a thumbnail file from ``THUMBS_DIR``.

    HTTP: GET /thumbnails/{name}
    Returns:
        ``FileResponse`` streaming the JPEG, or raises HTTPException
        (400 for a traversal-ish name, 404 when missing).
    Side effects:
        Every access is recorded to the audit log (public vs unredacted
        variants are tagged separately).
    """
    # Defensive check against path-traversal — reject ``..``, absolute-
    # path separators, and hidden-file names.
    if "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(400, "invalid name")
    path = THUMBS_DIR / name
    if not path.exists():
        raise HTTPException(404, "thumbnail not found")
    # ``request.client`` may be ``None`` under some test harnesses.
    ip = request.client.host if request.client else None
    kind = "access_public_thumbnail" if "_public." in name else "access_unredacted_thumbnail"
    audit.log(kind, name, outcome="success", ip=ip)
    # ``FileResponse`` streams a file from disk with proper Content-Type.
    return FileResponse(path)
