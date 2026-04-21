"""Test-runner routes (poll status / trigger run).

Exposes the in-process ``pytest`` runner used by the admin UI's "Run tests"
button. One endpoint reports status, the other kicks off a new run.

UI connection
-------------
Page: AdminPage — [file](frontend/src/features/tests/components/TestBadge.tsx)
       (also opens TestDrawer.tsx for full results).
UI element: the small "Run tests" badge in the page header — clicking it
opens a drawer that lists each test's pass/fail status and a "run again"
button.
Backend route(s): GET /api/tests/status, POST /api/tests/run.
"""

from fastapi import APIRouter

from backend.services.test_runner import run_state as test_run_state, start_test_run

# ``APIRouter`` — route grouping container.
router = APIRouter()


@router.get("/api/tests/status")
def api_test_status():
    """Current test run status and results.

    HTTP: GET /api/tests/status
    Returns: ``{"status": "idle"|"running"|"done", "results": [...], ...}``
        — used by the admin UI to poll progress.
    """
    return test_run_state.as_dict()


@router.post("/api/tests/run")
def api_test_run():
    """Trigger a new test run (if not already running).

    HTTP: POST /api/tests/run
    Takes no body.
    Returns: ``{"ok": True}`` when started, or ``{"ok": False,
        "reason": "already running"}`` when a run is already in flight
        (we refuse to double-book the runner).
    """
    if test_run_state.status == "running":
        return {"ok": False, "reason": "already running"}
    start_test_run()
    return {"ok": True}
