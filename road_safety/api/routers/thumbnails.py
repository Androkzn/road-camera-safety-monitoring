"""Public + DSAR-gated thumbnail serving."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from road_safety.compliance import audit
from road_safety.config import DSAR_TOKEN, THUMBS_DIR
from road_safety.security.signing import valid_thumb_request

router = APIRouter()


@router.get("/thumbnails/{name}")
def thumbnail(name: str, request: Request):
    """Serve redacted (public) thumbnails freely; gate unredacted on DSAR token.

    Public UI + Slack relay + SSE all reference ``*_public.jpg``. Requesting
    the internal unredacted ``evt_xxxx.jpg`` requires a preconfigured
    X-DSAR-Token header — the minimum viable DSAR (Data Subject Access
    Request) access workflow. With no token set in env, unredacted
    retrieval is closed entirely.

    HTTP: GET /thumbnails/{name}
    AUTH:
        * ``*_public.jpg`` — public, but requires a signed ``exp`` + ``token``
          pair when ``PUBLIC_THUMBS_REQUIRE_TOKEN`` is on.
        * Internal ``evt_*.jpg`` — requires ``X-DSAR-Token`` header.
    Args:
        name: Thumbnail filename from the URL path.
        request: FastAPI request, inspected for signing query params and
            the DSAR header.
    Returns:
        FileResponse streaming the JPEG, or raises HTTPException (400 for
        a traversal-ish name, 403 on auth fail, 404 when missing).
    Side effects:
        Every access — success or denial — is recorded to the audit log
        so a compliance reviewer can reconstruct who saw what.
    """
    # Basic path-traversal / hidden-file protection. ``THUMBS_DIR / name``
    # would otherwise happily resolve ``../../etc/passwd``.
    if "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(400, "invalid name")
    path = THUMBS_DIR / name
    if not path.exists():
        raise HTTPException(404, "thumbnail not found")
    ip = request.client.host if request.client else None
    if "_public." in name:
        if not valid_thumb_request(name, request):
            audit.log("access_public_thumbnail", name, outcome="denied", ip=ip)
            raise HTTPException(
                403,
                "public thumbnail requires valid exp/token query params",
            )
        audit.log("access_public_thumbnail", name, outcome="success", ip=ip)
        return FileResponse(path)
    # Internal unredacted path — DSAR-token required. Absence of env var
    # closes the gate entirely (``not DSAR_TOKEN`` short-circuits).
    token = request.headers.get("X-DSAR-Token")
    if not DSAR_TOKEN or token != DSAR_TOKEN:
        audit.log("access_unredacted_thumbnail", name, outcome="denied", ip=ip)
        raise HTTPException(
            403,
            "unredacted thumbnail — present X-DSAR-Token header "
            "(set ROAD_DSAR_TOKEN env var on the server)",
        )
    audit.log("access_unredacted_thumbnail", name, outcome="success", ip=ip)
    return FileResponse(path)
