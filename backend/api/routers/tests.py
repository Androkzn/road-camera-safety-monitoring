"""Test-runner routes (poll status / trigger run)."""

from fastapi import APIRouter, Request

from backend.security.auth import require_admin_if_flagged
from backend.services.test_runner import run_state as test_run_state, start_test_run

router = APIRouter()


@router.get("/api/tests/status")
def api_test_status():
    """Current test run status and results.

    HTTP: GET /api/tests/status
    AUTH: public (dashboard action)
    """
    return test_run_state.as_dict()


@router.post("/api/tests/run")
def api_test_run(request: Request):
    """Trigger a new test run (if not already running).

    HTTP: POST /api/tests/run
    AUTH: POC (open). Triggers a
        pytest subprocess; script-abuse would pin the CPU.
    Returns: ``{"ok": True}`` when started, or ``{"ok": False,
        "reason": "already running"}`` when a run is already in flight.
    """
    require_admin_if_flagged(request, realm="tests run")
    if test_run_state.status == "running":
        return {"ok": False, "reason": "already running"}
    start_test_run()
    return {"ok": True}
