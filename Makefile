.PHONY: install dev dev-hot dev-hot-lite dev-stop test lint run run-cloud start start-bg stop restart status logs docker-build docker-up docker-up-cloud docker-down clean

# --- Config ---
# Default port is 8001 (override: `make start PORT=8080`).
PORT ?= 8001
PID_FILE := .road_safety.pid
LOG_FILE := .road_safety.log

install:
	pip install -e .

dev:
	pip install -e ".[dev]"

test:
	pytest tests/ -v --tb=short

lint:
	python -m py_compile road_safety/server.py
	python -m py_compile road_safety/config.py
	python -m py_compile start.py

run:
	python start.py

run-cloud:
	python start.py --cloud

# --- Foreground app (with logs) ---
# Runs start.py in the foreground on :$(PORT). Logs stream to the terminal.
# Ctrl+C stops. Pre-flight frees :$(PORT) and kills stray stream workers so
# repeated `make start` runs don't hit "Address already in use".
start:
	@echo "pre-flight: freeing :$(PORT), killing stray stream workers..."
	@lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
	@pkill -9 -f "yt-dlp" 2>/dev/null || true
	@pkill -9 -f "ffmpeg.*pipe" 2>/dev/null || true
	@sleep 0.3
	@echo "starting on http://localhost:$(PORT) — Ctrl+C to stop"
	@trap 'echo; echo "shutting down..."; kill -TERM 0 2>/dev/null; sleep 0.5; kill -9 0 2>/dev/null; exit 0' INT TERM; \
	.venv/bin/python start.py --skip-tests --no-browser --port $(PORT)

# Background start: detached, logs to $(LOG_FILE), pid in $(PID_FILE) so
# `make stop` / `make status` / `make logs` can manage it.
start-bg:
	@if [ -f "$(PID_FILE)" ] && kill -0 "$$(cat $(PID_FILE))" 2>/dev/null; then \
		echo "Already running (pid $$(cat $(PID_FILE))). Use 'make stop' first, or 'make restart'."; \
		exit 1; \
	fi
	@if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t >/dev/null 2>&1; then \
		echo "Port $(PORT) is already bound (pid $$(lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t)). Stop that first or run 'make stop'."; \
		exit 1; \
	fi
	@echo "Starting on port $(PORT) — logs: $(LOG_FILE)"
	@nohup .venv/bin/python start.py --skip-tests --no-browser --port $(PORT) > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE)
	@sleep 1
	@echo "PID $$(cat $(PID_FILE))  ->  http://localhost:$(PORT)"
	@echo "Watch logs: make logs   Stop: make stop   Status: make status"

stop:
	@if [ -f "$(PID_FILE)" ]; then \
		PID=$$(cat $(PID_FILE)); \
		if kill -0 $$PID 2>/dev/null; then \
			echo "Stopping pid $$PID..."; \
			kill $$PID 2>/dev/null || true; \
			sleep 1; \
			kill -9 $$PID 2>/dev/null || true; \
		fi; \
		rm -f $(PID_FILE); \
	fi
	@PIDS=$$(lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null); \
	if [ -n "$$PIDS" ]; then \
		echo "Force-killing residual pids on :$(PORT): $$PIDS"; \
		echo "$$PIDS" | xargs kill -9 2>/dev/null || true; \
	fi
	@echo "Stopped."

restart: stop start-bg

status:
	@PID_ALIVE=""; \
	if [ -f "$(PID_FILE)" ] && kill -0 "$$(cat $(PID_FILE))" 2>/dev/null; then \
		PID_ALIVE="$$(cat $(PID_FILE))"; \
	fi; \
	PORT_PID=$$(lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null); \
	if [ -n "$$PID_ALIVE" ]; then \
		echo "Running (pid $$PID_ALIVE, http://localhost:$(PORT))"; \
	elif [ -n "$$PORT_PID" ]; then \
		echo "Port $(PORT) bound by pid $$PORT_PID (not started via 'make start-bg'). Run 'make stop' to clean up."; \
	else \
		echo "Not running."; \
	fi

logs:
	@touch $(LOG_FILE)
	@tail -f $(LOG_FILE)

# --- Hot-reload dev mode ---
# uvicorn --reload on :$(PORT) + Vite dev server on :3000.
# Open http://localhost:3000 — Vite proxies /api, /stream, etc. to the backend.
# Ctrl+C stops both processes together.
#
# Reload is scoped to road_safety/ *.py files only. Without this, every
# thumbnail write to data/ triggers a restart, which kills streams mid-startup
# and causes the Vite proxy to time out in a loop.
dev-hot:
	@echo "pre-flight: freeing :$(PORT), :3000, killing stray stream workers..."
	@lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
	@lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
	@pkill -9 -f "yt-dlp" 2>/dev/null || true
	@pkill -9 -f "ffmpeg.*pipe" 2>/dev/null || true
	@sleep 0.3
	@echo "launching: uvicorn :$(PORT) (reload scoped to road_safety/*.py) + vite :3000"
	@trap 'echo; echo "shutting down..."; kill -TERM 0 2>/dev/null; sleep 0.5; kill -9 0 2>/dev/null; exit 0' INT TERM; \
	.venv/bin/python -m uvicorn road_safety.server:app \
	    --reload --reload-dir road_safety --reload-include '*.py' --port $(PORT) & BE=$$!; \
	( cd frontend && npm run dev ) & FE=$$!; \
	wait $$BE $$FE

# Fast-startup dev mode: like dev-hot but forces bundled local MP4 clips
# instead of YouTube streams. Startup is ~2s vs ~70s because yt-dlp +
# ffmpeg don't have to negotiate live streams. Use this for everyday dev.
dev-hot-lite:
	@echo "pre-flight: freeing :$(PORT), :3000, killing stray stream workers..."
	@lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
	@lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
	@pkill -9 -f "yt-dlp" 2>/dev/null || true
	@pkill -9 -f "ffmpeg.*pipe" 2>/dev/null || true
	@sleep 0.3
	@echo "launching: uvicorn :$(PORT) (reload, LOCAL MP4s) + vite :3000"
	@trap 'echo; echo "shutting down..."; kill -TERM 0 2>/dev/null; sleep 0.5; kill -9 0 2>/dev/null; exit 0' INT TERM; \
	ROAD_STREAM_SOURCE='' .venv/bin/python -m uvicorn road_safety.server:app \
	    --reload --reload-dir road_safety --reload-include '*.py' --port $(PORT) & BE=$$!; \
	( cd frontend && npm run dev ) & FE=$$!; \
	wait $$BE $$FE

# Force-stop everything dev-hot / dev-hot-lite starts. Use when Ctrl+C didn't
# fully clean up (yt-dlp occasionally ignores SIGTERM during startup).
dev-stop:
	@echo "stopping dev servers and stream workers..."
	@lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
	@lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
	@pkill -9 -f "yt-dlp" 2>/dev/null || true
	@pkill -9 -f "ffmpeg.*pipe" 2>/dev/null || true
	@pkill -9 -f "uvicorn road_safety.server" 2>/dev/null || true
	@pkill -9 -f "vite" 2>/dev/null || true
	@echo "stopped."

# --- Docker ---
docker-build:
	docker compose build

docker-up:
	docker compose up -d

docker-up-cloud:
	docker compose --profile cloud up -d

docker-down:
	docker compose down

clean:
	rm -rf dist/ build/ *.egg-info .pytest_cache htmlcov .coverage
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
