.PHONY: install dev test test-be test-fe test-all lint typecheck typecheck-mypy generate-types run run-cloud start stop restart status logs docker-build docker-up docker-up-cloud docker-down clean

# --- Background dev-server shortcuts ---
# Terminal equivalents of the /start and /stop Claude Code slash commands.
# Default port is 8001 (override: `make start PORT=8080`).
PORT ?= 8001
PID_FILE := .road_safety.pid
LOG_FILE := .road_safety.log

install:
	pip install -e .

dev:
	pip install -e ".[dev]"

test: test-be

test-be:
	.venv/bin/python -m pytest tests/ -v --tb=short

test-fe:
	cd frontend && npm run test

test-all: test-be test-fe

lint:
	python -m py_compile backend/server.py
	python -m py_compile backend/config.py
	python -m py_compile start.py

typecheck:
	pyright

# Strict mypy on the scoped contract modules (audit §1.1): the pydantic
# models in backend/api/ and the LLM failover in backend/services/llm.py.
# See the ``[tool.mypy]`` block in pyproject.toml for the full scope.
typecheck-mypy:
	.venv/bin/python -m mypy --config-file pyproject.toml

# Regenerate frontend/src/shared/types/generated.ts from the pydantic
# models. ``start.py`` runs this automatically before the Vite build;
# this target is for iterating on a model without a full launch.
generate-types:
	.venv/bin/python scripts/generate_ts_types.py

run:
	python start.py

run-cloud:
	python start.py --cloud

start:
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

restart: stop start

status:
	@PID_ALIVE=""; \
	if [ -f "$(PID_FILE)" ] && kill -0 "$$(cat $(PID_FILE))" 2>/dev/null; then \
		PID_ALIVE="$$(cat $(PID_FILE))"; \
	fi; \
	PORT_PID=$$(lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null); \
	if [ -n "$$PID_ALIVE" ]; then \
		echo "Running (pid $$PID_ALIVE, http://localhost:$(PORT))"; \
	elif [ -n "$$PORT_PID" ]; then \
		echo "Port $(PORT) bound by pid $$PORT_PID (not started via 'make start'). Run 'make stop' to clean up."; \
	else \
		echo "Not running."; \
	fi

logs:
	@touch $(LOG_FILE)
	@tail -f $(LOG_FILE)

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
