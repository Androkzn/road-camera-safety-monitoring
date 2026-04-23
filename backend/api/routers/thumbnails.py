"""Thumbnail serving (fully open POC).

Serves event thumbnails on disk. Two variants exist per event:
``<id>.jpg`` (internal, unredacted) and ``<id>_public.jpg`` (face/plate
blurred — the only variant shared channels like Slack should link to;
see ``backend/services/redact.py::write_thumbnails``). Every access is
audit-logged so a reviewer can reconstruct who viewed which image,
with ``_public`` vs unredacted tagged separately in the log.

Endpoints
---------
* ``GET /thumbnails/{name}`` — stream a thumbnail by filename.

UI connection
-------------
Page: DashboardPage + AdminPage + MonitoringPage + ValidationPage.
FE consumers:
* ``EventCard`` (frontend/src/shared/events/EventCard.tsx) — the small
  preview image on every event card (uses ``thumb_url`` from the
  SafetyEvent, typically pointing at the ``_public`` variant).
* ``EventDialog`` (frontend/src/shared/events/EventDialog.tsx) — the
  larger image inside the event-detail dialog.
* ``AdminEventCard`` / ``HistoryPanel`` — admin-only variants.
UI element: the small redacted preview image on every event card across
all pages, and the larger image inside the event-detail dialog.

Backend services used
---------------------
* ``backend.config.THUMBS_DIR`` — on-disk root for thumbnail writes.
* ``backend.compliance.audit`` — every access is audit-logged (public
  vs unredacted variants tagged separately, plus client IP).

Privacy / security notes
------------------------
* The ``_public`` variant is the ONLY variant that may be exposed on
  shared channels (Slack links, cloud receiver, external dashboards).
  This router currently serves both variants by name; external channels
  must link only to ``*_public.*`` names. The audit log differentiates
  variants so unauthorised access to unredacted files is detectable.
* A path-traversal guard rejects ``/``, ``\\``, and leading ``.`` — the
  last also prevents accidental exposure of dotfiles inside the
  thumbnails directory.
* POC has no request authentication. Production deployments must gate
  this behind a real auth layer before exposing publicly — see
  CLAUDE.md "Access model".
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
        variants are tagged separately so reviewer can spot unredacted
        leaks).

    FE caller: ``EventCard`` / ``EventDialog`` / ``AdminEventCard`` via
    the ``thumb_url`` field on a ``SafetyEvent``.

    Privacy: shared/external channels must only reference ``*_public.*``
    names. The unredacted variant stays on this endpoint for in-house
    review; audit tagging distinguishes the two.
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
