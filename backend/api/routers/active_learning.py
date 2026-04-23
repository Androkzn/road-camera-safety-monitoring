"""Active-learning export route (labelling pool → zip).

Active-learning = "ask a human to label only the examples the model is
most uncertain about". This router exposes a single endpoint that packs
the current labelling pool into a zip for import into Label Studio / CVAT.

UI connection
-------------
Page: None (operator-only endpoint, not wired to the React frontend).
UI element: No direct UI — used out-of-band by an operator who downloads
the produced zip and imports it into Label Studio / CVAT for human labelling.
Backend route(s): POST /api/active_learning/export.
"""

from fastapi import APIRouter, HTTPException

from backend.compliance import audit
from backend.state import state

# ``APIRouter`` groups a set of routes — included into the main FastAPI
# app later via ``app.include_router(router)``.
router = APIRouter()


# ``@router.post("/...")`` — decorator that attaches the function below
# as the HTTP POST handler for this URL.
@router.post("/api/active_learning/export")
def api_active_learning_export():
    """Bundle pending active-learning samples into a zip for Label Studio /
    CVAT import. Returns the zip path (on-disk; operator downloads it
    out-of-band) or 204 when the pool is empty.

    HTTP: POST /api/active_learning/export
    Returns: ``{"path": "<absolute-path-to-zip>"}`` or 204 no-content.
    Raises:
        500 if the exporter raises (disk full, permissions, etc.).
        204 (as an HTTPException) when no pending samples — callers
            treat this as "nothing to do, try again later".
    """
    audit.log("export_active_learning", "batch_export")
    try:
        path = state.active_learner.export_batch()
    except Exception as exc:
        raise HTTPException(500, f"export failed: {exc}")
    if path is None:
        raise HTTPException(204, "no pending samples")
    return {"path": str(path)}
