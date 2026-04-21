---
description: Start the road-safety app on port 8002 in the background
---

Start the local app server.

Do the following steps:

1. Check whether port 8002 is already bound. If something is already listening, tell the user and STOP — don't silently start a second instance. Command:
   `lsof -nP -iTCP:8002 -sTCP:LISTEN`

2. If port 8002 is free, launch the app in the background using the Bash tool with `run_in_background: true`:
   `.venv/bin/python start.py --skip-tests --no-browser --port 8002 2>&1`

3. Start a Monitor watching the task's output file for the ready signal (`agent executor ready`) and for any fatal errors (`Traceback`, `ImportError`, `ModuleNotFoundError`, `SyntaxError`, `address already in use`, `Killed`, `exit code`). Timeout: 180 seconds.

4. When the ready signal arrives, verify health:
   `curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8002/api/live/status`

5. Report to the user: the URL `http://localhost:8002`, the background task id, and any non-fatal warnings seen during startup (for example the default YouTube slot failing to resolve is expected and shouldn't block).

Notes:
- Use `--port 8002` — this is a saved preference.
- Do NOT open a browser (the `--no-browser` flag suppresses it); the user opens the URL themselves.
- Do NOT run tests during startup (`--skip-tests` is the fast path).
