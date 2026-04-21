.PHONY: install dev test lint run start start-bg stop restart status logs docker-build docker-up docker-down clean

ROAD_PORT ?= 8000
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

start:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Already running (PID $$(cat $(PID_FILE)))"; \
	else \
		echo "Starting on :$(ROAD_PORT) (logs: $(LOG_FILE))"; \
		nohup python start.py --skip-tests --no-browser --port $(ROAD_PORT) > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
		sleep 1; \
		echo "PID $$(cat $(PID_FILE))"; \
	fi
	@echo "--- streaming $(LOG_FILE) (Ctrl-C to detach; server keeps running) ---"
	@tail -n +1 -f $(LOG_FILE)

start-bg:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Already running (PID $$(cat $(PID_FILE)))"; \
		exit 0; \
	fi
	@echo "Starting on :$(ROAD_PORT) (logs: $(LOG_FILE))"
	@nohup python start.py --skip-tests --no-browser --port $(ROAD_PORT) > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE)
	@sleep 1
	@echo "PID $$(cat $(PID_FILE))"

stop:
	@if [ -f $(PID_FILE) ]; then \
		PID=$$(cat $(PID_FILE)); \
		if kill -0 $$PID 2>/dev/null; then \
			echo "Stopping PID $$PID"; \
			kill $$PID 2>/dev/null || true; \
			sleep 1; \
			kill -9 $$PID 2>/dev/null || true; \
		fi; \
		rm -f $(PID_FILE); \
	fi
	@LSOF_PIDS=$$(lsof -ti tcp:$(ROAD_PORT) 2>/dev/null); \
	if [ -n "$$LSOF_PIDS" ]; then \
		echo "Force-killing leftover processes on :$(ROAD_PORT): $$LSOF_PIDS"; \
		kill -9 $$LSOF_PIDS 2>/dev/null || true; \
	fi
	@echo "Stopped."

restart: stop start

status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Running (PID $$(cat $(PID_FILE))) on :$(ROAD_PORT)"; \
	else \
		echo "Not running"; \
	fi

logs:
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
