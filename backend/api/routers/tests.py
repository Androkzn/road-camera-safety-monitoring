"""Test-runner routes (poll status / trigger run)."""

from fastapi import APIRouter

from backend.services.test_runner import run_state as test_run_state, start_test_run

router = APIRouter()


@router.get("/api/tests/status")
def api_test_status():
    """Current test run status and results.

    HTTP: GET /api/tests/status
    """
    return test_run_state.as_dict()


@router.post("/api/tests/run")
def api_test_run():
    """Trigger a new test run (if not already running).

    HTTP: POST /api/tests/run
    Returns: ``{"ok": True}`` when started, or ``{"ok": False,
        "reason": "already running"}`` when a run is already in flight.
    """
    if test_run_state.status == "running":
        return {"ok": False, "reason": "already running"}
    start_test_run()
    return {"ok": True}
