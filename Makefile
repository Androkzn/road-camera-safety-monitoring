.PHONY: install dev test test-be test-fe test-all lint typecheck run docker-build docker-up docker-down clean

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

run:
	python start.py

run-cloud:
	python start.py --cloud

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
