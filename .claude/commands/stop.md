---
description: Stop the road-safety app running on port 8000
---

Stop the local app server.

Do the following steps:

1. Find the process(es) listening on port 8000:
   `lsof -nP -iTCP:8000 -sTCP:LISTEN -t`

   This returns PID(s) (one per line). If there's no output, the app is already stopped — tell the user so and finish.

2. If there are background tasks tracked in this conversation for `start.py` (task ids from earlier `run_in_background` calls), prefer `TaskStop` on those task ids over `kill`. `TaskStop` is cleaner because it goes through the same shell that launched the process and reaps children properly.

3. If there's no tracked task id, or TaskStop doesn't free the port, fall back to signalling the PIDs returned in step 1:
   `kill <pid>` first (graceful SIGTERM), then verify the port is free. If the port is still bound after ~2 seconds, escalate to `kill -9 <pid>`.

4. Verify the port is free:
   `lsof -nP -iTCP:8000 -sTCP:LISTEN`
   (no output = free)

5. Report to the user: confirm the app is stopped. If any child processes (uvicorn workers, ffmpeg, yt-dlp) are still lingering, list them so the user knows.

Notes:
- Be careful not to kill unrelated processes. Only act on PIDs bound to port 8000.
- Never use `pkill -f python` or similar broad filters — they could kill unrelated Python processes (e.g. an editor language server).
