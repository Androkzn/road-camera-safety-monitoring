#!/usr/bin/env python3
"""One-command launcher: starts the Fleet Safety server, waits for it to be
healthy, then opens the admin dashboard in the default browser.

Usage:
    python start.py              # main server only (port 8000)
    python start.py --cloud      # also start cloud_receiver on port 8001
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
PYTHON = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable

SERVER_HOST = os.getenv("FLEET_HOST", "127.0.0.1")
SERVER_PORT = int(os.getenv("FLEET_PORT", "8000"))
CLOUD_PORT = int(os.getenv("FLEET_CLOUD_PORT", "8001"))
HEALTH_URL = f"http://{SERVER_HOST}:{SERVER_PORT}/api/live/status"
ADMIN_URL = f"http://{SERVER_HOST}:{SERVER_PORT}/admin"

ANSI_GREEN = "\033[92m"
ANSI_YELLOW = "\033[93m"
ANSI_RED = "\033[91m"
ANSI_CYAN = "\033[96m"
ANSI_BOLD = "\033[1m"
ANSI_DIM = "\033[2m"
ANSI_RESET = "\033[0m"


def banner():
    print(f"""
{ANSI_CYAN}{ANSI_BOLD}  Fleet Safety Demo{ANSI_RESET}
{ANSI_DIM}  ─────────────────────────────────────{ANSI_RESET}
""")


def wait_for_health(url: str, timeout: int = 120) -> dict | None:
    """Poll the health endpoint until the server responds or timeout."""
    start = time.time()
    attempt = 0
    while time.time() - start < timeout:
        attempt += 1
        dots = "." * (attempt % 4)
        print(f"\r  {ANSI_YELLOW}Waiting for server{dots:<4}{ANSI_RESET}", end="", flush=True)
        try:
            import json
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                print(f"\r  {ANSI_GREEN}Server is up!{' ' * 20}{ANSI_RESET}")
                return data
        except Exception:
            time.sleep(1.5)
    print(f"\r  {ANSI_RED}Timed out waiting for server ({timeout}s){ANSI_RESET}")
    return None


def print_status(data: dict):
    """Print a summary of server status to the terminal."""
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

    dot = f"{ANSI_GREEN}●{ANSI_RESET}" if running else f"{ANSI_RED}●{ANSI_RESET}"

    print(f"""
  {ANSI_BOLD}Server Status{ANSI_RESET}
  ─────────────────────────────────────
  {dot} Stream        {ANSI_DIM}{source[:60]}{ANSI_RESET}
    Target FPS    {fps}
    Frames done   {frames}
    Events        {events}
    Tracker       {tracker}
    Risk model    {risk_model}
    Perception    {p_state}
    LLM           {"configured" if llm else "not configured"}
    Slack         {"configured" if slack else "not configured"}
  ─────────────────────────────────────
  {ANSI_CYAN}Admin UI{ANSI_RESET}      {ADMIN_URL}
  {ANSI_CYAN}Dashboard{ANSI_RESET}     http://{SERVER_HOST}:{SERVER_PORT}/
  {ANSI_CYAN}API status{ANSI_RESET}    {HEALTH_URL}
  ─────────────────────────────────────
""")


def main():
    parser = argparse.ArgumentParser(description="Start Fleet Safety servers")
    parser.add_argument("--cloud", action="store_true", help="Also start cloud_receiver on port 8001")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open the browser")
    parser.add_argument("--port", type=int, default=SERVER_PORT, help="Server port (default 8000)")
    args = parser.parse_args()

    port = args.port
    health_url = f"http://{SERVER_HOST}:{port}/api/live/status"
    admin_url = f"http://{SERVER_HOST}:{port}/admin"

    banner()

    procs: list[subprocess.Popen] = []

    def cleanup(sig=None, frame=None):
        print(f"\n  {ANSI_YELLOW}Shutting down…{ANSI_RESET}")
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    print(f"  {ANSI_DIM}Starting main server on :{port}…{ANSI_RESET}")
    server_proc = subprocess.Popen(
        [PYTHON, "-m", "uvicorn", "server:app",
         "--host", SERVER_HOST, "--port", str(port),
         "--log-level", "warning"],
        cwd=str(ROOT),
    )
    procs.append(server_proc)

    if args.cloud:
        print(f"  {ANSI_DIM}Starting cloud receiver on :{CLOUD_PORT}…{ANSI_RESET}")
        cloud_proc = subprocess.Popen(
            [PYTHON, "-m", "uvicorn", "cloud_receiver:app",
             "--host", SERVER_HOST, "--port", str(CLOUD_PORT),
             "--log-level", "warning"],
            cwd=str(ROOT),
        )
        procs.append(cloud_proc)

    data = wait_for_health(health_url)
    if data is None:
        print(f"  {ANSI_RED}Server failed to start. Check logs above.{ANSI_RESET}")
        cleanup()
        return

    print_status(data)

    if not args.no_browser:
        print(f"  {ANSI_GREEN}Opening browser…{ANSI_RESET}")
        webbrowser.open(admin_url)

    print(f"  {ANSI_DIM}Press Ctrl+C to stop.{ANSI_RESET}\n")

    try:
        server_proc.wait()
    except KeyboardInterrupt:
        cleanup()


if __name__ == "__main__":
    main()
