"""test_runner.py — runs pytest in the background and exposes live results.

What it does:
    Launches the project's pytest suite in a background thread so the
    dashboard can show which tests passed, which failed, and how long
    the whole run took — without freezing the web server. Parses pytest's
    JSON report into a per-test list (file, name, outcome, duration,
    failure message) plus aggregate counts.

Purpose:
    Lets operators see test health directly in the UI (a red "tests
    failing" badge, a drawer with the failing test names) instead of
    having to shell into the host and run pytest manually.

How it works:
    * Runs pytest as a subprocess (``subprocess.run``) so it can't
      accidentally affect the running server process. The venv's
      ``python`` is preferred when it exists; otherwise system python.
    * A background ``threading.Thread`` is used (not asyncio) because
      pytest blocks and spins up its own subprocess; a thread keeps the
      event loop free.
    * ``@dataclass`` auto-generates typed record classes ``TestResult``
      and ``TestRunState``. A ``threading.Lock`` guards ``TestRunState``
      because the runner writes to it from one thread while the API
      reads from another.
    * ``as_dict()`` returns a JSON-serialisable snapshot for the API.
    * First does a ``--collect-only`` pass to populate ``total`` early
      (so the UI progress bar is accurate); then runs the real suite
      with ``--json-report``. If ``pytest-json-report`` isn't installed
      it falls back to parsing plain pytest stdout (``_run_pytest_basic``).
    * 120-second timeout guards against hangs.

Connects to:
    - Backend: ``road_safety/server.py`` imports ``run_state`` and
      ``start_test_run``; exposes ``/api/tests/status`` (GET) and
      ``/api/tests/run`` (POST).
    - UI: ``frontend/src/lib/api.ts`` ``getTestStatus`` / ``runTests``;
      ``frontend/src/hooks/useTests.ts`` polls the status;
      ``frontend/src/components/tests/TestBadge.tsx`` and
      ``TestDrawer.tsx`` render the counts and failing tests in the
      TopBar.
"""

from __future__ import annotations

import subprocess
import json
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from road_safety.config import PROJECT_ROOT


@dataclass
class TestResult:
    node_id: str
    file: str
    name: str
    outcome: str  # "passed", "failed", "error", "skipped"
    duration_ms: float = 0.0
    message: str = ""


@dataclass
class TestRunState:
    status: str = "idle"  # idle | running | passed | failed
    started_at: float = 0.0
    finished_at: float = 0.0
    total: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    skipped: int = 0
    progress: int = 0
    results: list[TestResult] = field(default_factory=list)
    error_output: str = ""
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def as_dict(self) -> dict:
        with self._lock:
            elapsed = 0.0
            if self.started_at:
                end = self.finished_at or time.time()
                elapsed = round(end - self.started_at, 2)
            return {
                "status": self.status,
                "elapsed_sec": elapsed,
                "total": self.total,
                "passed": self.passed,
                "failed": self.failed,
                "errors": self.errors,
                "skipped": self.skipped,
                "progress": self.progress,
                "results": [
                    {
                        "node_id": r.node_id,
                        "file": r.file,
                        "name": r.name,
                        "outcome": r.outcome,
                        "duration_ms": round(r.duration_ms, 1),
                        "message": r.message,
                    }
                    for r in self.results
                ],
                "error_output": self.error_output,
            }


run_state = TestRunState()

_VENV_PYTHON = PROJECT_ROOT / ".venv" / "bin" / "python"
_PYTHON = str(_VENV_PYTHON) if _VENV_PYTHON.exists() else "python"


def _parse_json_report(report_path: Path) -> None:
    """Parse a pytest-json-report file into structured results."""
    if not report_path.exists():
        return
    try:
        data = json.loads(report_path.read_text())
    except (json.JSONDecodeError, OSError):
        return

    tests = data.get("tests", [])
    with run_state._lock:
        run_state.total = len(tests)
        run_state.passed = 0
        run_state.failed = 0
        run_state.errors = 0
        run_state.skipped = 0
        run_state.results = []

        for t in tests:
            node_id = t.get("nodeid", "")
            outcome = t.get("outcome", "unknown")
            duration = t.get("duration", 0.0) * 1000
            # Extract file and test name from node_id like "tests/test_core.py::TestX::test_y"
            parts = node_id.split("::")
            file_part = parts[0] if parts else ""
            name_part = "::".join(parts[1:]) if len(parts) > 1 else node_id

            message = ""
            call = t.get("call", {})
            if outcome == "failed" and call:
                longrepr = call.get("longrepr", "")
                if longrepr:
                    message = longrepr if len(longrepr) < 500 else longrepr[:500] + "…"

            result = TestResult(
                node_id=node_id,
                file=file_part,
                name=name_part,
                outcome=outcome,
                duration_ms=duration,
                message=message,
            )
            run_state.results.append(result)

            if outcome == "passed":
                run_state.passed += 1
            elif outcome == "failed":
                run_state.failed += 1
            elif outcome == "error":
                run_state.errors += 1
            elif outcome == "skipped":
                run_state.skipped += 1

        run_state.progress = run_state.total


def _run_pytest() -> None:
    """Run pytest in a subprocess, capturing structured output."""
    report_path = PROJECT_ROOT / ".test-report.json"
    if report_path.exists():
        report_path.unlink()

    with run_state._lock:
        run_state.status = "running"
        run_state.started_at = time.time()
        run_state.finished_at = 0.0
        run_state.total = 0
        run_state.passed = 0
        run_state.failed = 0
        run_state.errors = 0
        run_state.skipped = 0
        run_state.progress = 0
        run_state.results = []
        run_state.error_output = ""

    # First, do a collection pass to get total count.
    try:
        collect = subprocess.run(
            [_PYTHON, "-m", "pytest", "tests/", "--collect-only", "-q", "--no-header"],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=30,
        )
        # Count lines like "tests/test_core.py::TestBbox::test_x"
        count = 0
        for line in collect.stdout.strip().splitlines():
            if "::" in line:
                count += 1
        if count > 0:
            with run_state._lock:
                run_state.total = count
    except Exception:
        pass

    # Run the actual tests with JSON report.
    try:
        result = subprocess.run(
            [
                _PYTHON, "-m", "pytest", "tests/",
                "-x",
                "--tb=short",
                "--no-header",
                f"--json-report-file={report_path}",
                "--json-report",
            ],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=120,
        )
        _parse_json_report(report_path)

        with run_state._lock:
            run_state.finished_at = time.time()
            if run_state.failed > 0 or run_state.errors > 0:
                run_state.status = "failed"
                if result.stdout:
                    lines = result.stdout.strip().splitlines()
                    run_state.error_output = "\n".join(lines[-20:])
            else:
                run_state.status = "passed"

    except subprocess.TimeoutExpired:
        with run_state._lock:
            run_state.status = "failed"
            run_state.finished_at = time.time()
            run_state.error_output = "Test suite timed out after 120 seconds"
    except FileNotFoundError:
        # pytest-json-report not installed, fall back to basic parsing
        _run_pytest_basic()
    except Exception as exc:
        with run_state._lock:
            run_state.status = "failed"
            run_state.finished_at = time.time()
            run_state.error_output = str(exc)
    finally:
        if report_path.exists():
            try:
                report_path.unlink()
            except OSError:
                pass


def _run_pytest_basic() -> None:
    """Fallback: run pytest with verbose output and parse results from stdout."""
    try:
        result = subprocess.run(
            [
                _PYTHON, "-m", "pytest", "tests/",
                "-v", "--tb=short", "--no-header",
            ],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=120,
        )

        with run_state._lock:
            run_state.results = []
            run_state.passed = 0
            run_state.failed = 0
            run_state.errors = 0
            run_state.skipped = 0

            for line in result.stdout.splitlines():
                # Match lines like: tests/test_core.py::TestX::test_y PASSED
                m = re.match(r'^(tests/\S+::\S+)\s+(PASSED|FAILED|ERROR|SKIPPED)', line)
                if not m:
                    continue
                node_id = m.group(1)
                outcome = m.group(2).lower()
                parts = node_id.split("::")
                file_part = parts[0] if parts else ""
                name_part = "::".join(parts[1:]) if len(parts) > 1 else node_id

                run_state.results.append(TestResult(
                    node_id=node_id,
                    file=file_part,
                    name=name_part,
                    outcome=outcome,
                ))

                if outcome == "passed":
                    run_state.passed += 1
                elif outcome == "failed":
                    run_state.failed += 1
                elif outcome == "error":
                    run_state.errors += 1
                elif outcome == "skipped":
                    run_state.skipped += 1

            run_state.total = len(run_state.results)
            run_state.progress = run_state.total
            run_state.finished_at = time.time()

            if run_state.failed > 0 or run_state.errors > 0:
                run_state.status = "failed"
                lines = result.stdout.strip().splitlines()
                run_state.error_output = "\n".join(lines[-20:])
            else:
                run_state.status = "passed"

    except subprocess.TimeoutExpired:
        with run_state._lock:
            run_state.status = "failed"
            run_state.finished_at = time.time()
            run_state.error_output = "Test suite timed out after 120 seconds"
    except Exception as exc:
        with run_state._lock:
            run_state.status = "failed"
            run_state.finished_at = time.time()
            run_state.error_output = str(exc)


def start_test_run() -> None:
    """Launch the test suite in a background thread. Non-blocking."""
    if run_state.status == "running":
        return
    t = threading.Thread(target=_run_pytest, daemon=True, name="test-runner")
    t.start()
