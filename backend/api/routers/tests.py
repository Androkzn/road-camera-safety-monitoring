"""Test-runner routes (poll status / trigger run).

Exposes the in-process ``pytest`` runner used by the admin UI's "Run tests"
button. One endpoint reports status, the other kicks off a new run.

Endpoints
---------
* ``GET  /api/tests/status`` — poll current run state + results.
* ``POST /api/tests/run`` — start a new run (refused if one is already
  in flight — ``test_runner`` keeps only one subprocess alive at a
  time to avoid port/DB contention).

UI connection
-------------
Page: AdminPage, DashboardPage (badge also mounts in the page header).
FE hooks that consume this router:
* ``useTests`` (frontend/src/features/tests/hooks/useTests.ts) — polls
  ``/api/tests/status`` and POSTs to ``/api/tests/run``.
* ``TestBadge`` (frontend/src/features/tests/components/TestBadge.tsx)
  — header badge showing pass/fail summary.
* ``TestDrawer`` (frontend/src/features/tests/components/TestDrawer.tsx)
  — drawer with per-test results and a "run again" button.
UI element: the small "Run tests" badge in the page header — clicking it
opens a drawer that lists each test's pass/fail status and a "run again"
button.

Backend services used
---------------------
* ``backend.services.test_runner`` — ``run_state`` holds the status
  singleton; ``start_test_run`` spawns the background subprocess. The
  runner enforces a single-process lifecycle: one run at a time, status
  transitions ``idle → running → done``, results retained until the
  next run overwrites them.

Security notes
--------------
* POC has no auth; anyone reachable on the network can trigger a test
  run. A concurrent-run guard is the only protection against abuse.
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

    Process lifecycle: a single pytest subprocess is spawned and owned
    by ``test_runner``. Status flips to ``running`` synchronously before
    this handler returns; the subprocess later flips it to ``done``
    with the collected results when it exits.
    """
    # Refuse to kick off a new run if one is still in flight — the
    # runner owns a single subprocess slot and parallel runs would
    # collide on coverage, temp dirs, and ``run_state``.
    if test_run_state.status == "running":
        return {"ok": False, "reason": "already running"}
    start_test_run()
    return {"ok": True}
