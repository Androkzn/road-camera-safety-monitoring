"""Thumbnail serving (fully open POC)."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from backend.compliance import audit
from backend.config import THUMBS_DIR

router = APIRouter()


@router.get("/thumbnails/{name}")
def thumbnail(name: str, request: Request):
    """Serve a thumbnail file from ``THUMBS_DIR``.

    HTTP: GET /thumbnails/{name}
    Returns:
        FileResponse streaming the JPEG, or raises HTTPException
        (400 for a traversal-ish name, 404 when missing).
    Side effects:
        Every access is recorded to the audit log.
    """
    if "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(400, "invalid name")
    path = THUMBS_DIR / name
    if not path.exists():
        raise HTTPException(404, "thumbnail not found")
    ip = request.client.host if request.client else None
    kind = "access_public_thumbnail" if "_public." in name else "access_unredacted_thumbnail"
    audit.log(kind, name, outcome="success", ip=ip)
    return FileResponse(path)
