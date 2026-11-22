# Developer shortcuts. Every target has an equivalent plain command in README.md.
PYTHON ?= python3.12
VENV := .venv
PY := $(VENV)/bin/python

.PHONY: setup backend frontend dev test test-backend test-frontend lint e2e up down logs reset-workspace check

setup: ## Create .venv, install backend (dev) and frontend dependencies
	$(PYTHON) -m venv $(VENV)
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r backend/requirements-dev.lock
	$(PY) -m pip install --no-deps -e backend
	cd frontend && npm ci --no-audit --no-fund

backend: ## Run the API on http://127.0.0.1:8000 (seeds ./workspace from fixtures on first run)
	cd backend && ../$(PY) -m app

frontend: ## Run the UI on http://127.0.0.1:5173 (proxies /api to the backend)
	cd frontend && npx vite

dev: ## Run backend and frontend together
	$(MAKE) -j2 backend frontend

test: test-backend test-frontend ## Run all automated tests (offline)

test-backend:
	cd backend && ../$(PY) -m pytest

test-frontend:
	cd frontend && npx vitest run

lint: ## Static checks: ruff, mypy (strict), tsc, eslint
	cd backend && ../$(PY) -m ruff check app tests && ../$(PY) -m ruff format --check app tests && ../$(PY) -m mypy app
	cd frontend && npx tsc --noEmit -p tsconfig.json && npx eslint .

e2e: ## Browser smoke test against a running stack (E2E_BASE_URL, default http://127.0.0.1:5173)
	cd frontend && npx playwright test

check: lint test ## Everything that runs without a started stack

up: ## Build and start the offline demo with Docker Compose
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f

reset-workspace: ## Delete local derived state and re-seed synthetic fixtures on next start
	rm -rf workspace
