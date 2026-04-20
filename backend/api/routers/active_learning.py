"""Active-learning export route (labelling pool → zip)."""

from fastapi import APIRouter, HTTPException

from backend.compliance import audit
from backend.state import state

router = APIRouter()


@router.post("/api/active_learning/export")
def api_active_learning_export():
    """Bundle pending active-learning samples into a zip for Label Studio /
    CVAT import. Returns the zip path (on-disk; operator downloads it
    out-of-band) or 204 when the pool is empty.

    HTTP: POST /api/active_learning/export
    Returns: ``{"path": "<absolute-path-to-zip>"}`` or 204 no-content.
    """
    audit.log("export_active_learning", "batch_export")
    try:
        path = state.active_learner.export_batch()
    except Exception as exc:
        raise HTTPException(500, f"export failed: {exc}")
    if path is None:
        raise HTTPException(204, "no pending samples")
    return {"path": str(path)}
