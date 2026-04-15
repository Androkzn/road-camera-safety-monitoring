#!/usr/bin/env python3
"""One-command launcher: starts the Road Safety server, runs tests,
waits for it to be healthy, then opens the admin dashboard in the browser.

Usage:
    python start.py                # start + test + open browser
    python start.py --skip-tests   # start without running tests
    python start.py --cloud        # also start cloud_receiver on port 8001
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent
FRONTEND_DIR = ROOT / "frontend"
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
PYTHON = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable

SERVER_HOST = os.getenv("ROAD_HOST", "127.0.0.1")
SERVER_PORT = int(os.getenv("ROAD_PORT", "8000"))
CLOUD_PORT = int(os.getenv("ROAD_CLOUD_PORT", "8001"))

G = "\033[92m"
Y = "\033[93m"
R = "\033[91m"
C = "\033[96m"
B = "\033[1m"
D = "\033[2m"
Z = "\033[0m"


def banner():
    print(f"""
{C}{B}  Road Safety{Z}
{D}  ─────────────────────────────────────{Z}
""")


def run_tests() -> bool:
    """Run the pytest suite. Returns True if all tests pass."""
    print(f"  {Y}Running tests…{Z}")
    result = subprocess.run(
        [PYTHON, "-m", "pytest", "tests/", "-x", "-q", "--tb=short", "--no-header"],
        cwd=str(ROOT),
    )
    if result.returncode == 0:
        print(f"  {G}All tests passed{Z}\n")
        return True
    print(f"  {R}Some tests failed (exit {result.returncode}){Z}\n")
    return False


def wait_for_health(url: str, timeout: int = 120) -> dict | None:
    start = time.time()
    attempt = 0
    while time.time() - start < timeout:
        attempt += 1
        dots = "." * (attempt % 4)
        print(f"\r  {Y}Waiting for server{dots:<4}{Z}", end="", flush=True)
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                print(f"\r  {G}Server is up!{' ' * 20}{Z}")
                return data
        except Exception:
            time.sleep(1.5)
    print(f"\r  {R}Timed out waiting for server ({timeout}s){Z}")
    return None


def print_status(data: dict, port: int):
    running = data.get("running", False)
    source = data.get("source", "—")
    fps = data.get("target_fps", "—")
    events = data.get("event_count", 0)
    frames = data.get("frames_processed", 0)
    llm = data.get("llm_configured", False)
    slack = data.get("slack_configured", False)
    tracker = data.get("tracker", "—")
    risk_model = data.get("risk_model", "—")
    perception = data.get("perception", {})
    p_state = perception.get("state", "—")
    dot = f"{G}●{Z}" if running else f"{R}●{Z}"
    admin_url = f"http://{SERVER_HOST}:{port}/admin"
    health_url = f"http://{SERVER_HOST}:{port}/api/live/status"

    print(f"""
  {B}Server Status{Z}
  ─────────────────────────────────────
  {dot} Stream        {D}{source[:60]}{Z}
    Target FPS    {fps}
    Frames done   {frames}
    Events        {events}
    Tracker       {tracker}
    Risk model    {risk_model}
    Perception    {p_state}
    LLM           {"configured" if llm else "not configured"}
    Slack         {"configured" if slack else "not configured"}
  ─────────────────────────────────────
  {C}Admin UI{Z}      {admin_url}
  {C}Dashboard{Z}     http://{SERVER_HOST}:{port}/
  {C}API status{Z}    {health_url}
  ─────────────────────────────────────
""")


def main():
    parser = argparse.ArgumentParser(description="Start Road Safety servers")
    parser.add_argument("--cloud", action="store_true", help="Also start cloud_receiver on port 8001")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open the browser")
    parser.add_argument("--skip-tests", action="store_true", help="Skip running the test suite")
    parser.add_argument("--port", type=int, default=SERVER_PORT, help="Server port (default 8000)")
    args = parser.parse_args()

    port = args.port
    health_url = f"http://{SERVER_HOST}:{port}/api/live/status"
    admin_url = f"http://{SERVER_HOST}:{port}/admin"

    banner()

    procs: list[subprocess.Popen] = []

    def cleanup(sig=None, frame=None):
        print(f"\n  {Y}Shutting down…{Z}")
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    if not args.skip_tests:
        run_tests()

    print(f"  {D}Starting main server on :{port}…{Z}")
    server_proc = subprocess.Popen(
        [PYTHON, "-m", "uvicorn", "road_safety.server:app",
         "--host", SERVER_HOST, "--port", str(port),
         "--log-level", "warning"],
        cwd=str(ROOT),
    )
    procs.append(server_proc)

    if args.cloud:
        print(f"  {D}Starting cloud receiver on :{CLOUD_PORT}…{Z}")
        cloud_proc = subprocess.Popen(
            [PYTHON, "-m", "uvicorn", "cloud.receiver:app",
             "--host", SERVER_HOST, "--port", str(CLOUD_PORT),
             "--log-level", "warning"],
            cwd=str(ROOT),
        )
        procs.append(cloud_proc)

    data = wait_for_health(health_url)
    if data is None:
        print(f"  {R}Server failed to start. Check logs above.{Z}")
        cleanup()
        return

    print_status(data, port)

    if not args.no_browser:
        print(f"  {G}Opening browser…{Z}")
        webbrowser.open(admin_url)

    print(f"  {D}Press Ctrl+C to stop.{Z}\n")

    try:
        server_proc.wait()
    except KeyboardInterrupt:
        cleanup()


if __name__ == "__main__":
    main()
