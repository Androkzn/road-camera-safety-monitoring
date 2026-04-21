.PHONY: install dev test test-be test-fe test-all lint typecheck typecheck-mypy generate-types run docker-build docker-up docker-down clean

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
