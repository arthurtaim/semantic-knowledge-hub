# Developer shortcuts. Every target has an equivalent plain command in README.md.
PYTHON ?= python3.12
VENV := .venv
PY := $(VENV)/bin/python

INTEGRATION_ENV ?= deploy/integration/integration.env
COMPOSE_INTEGRATION = docker compose --env-file $(INTEGRATION_ENV) -f docker-compose.yml -f docker-compose.integration.yml
# integration_mock profile: separate compose project + volume, UI on 127.0.0.1:5174, doubles not published.
COMPOSE_MOCK = FRONTEND_PORT=5174 docker compose -p skh-mock -f docker-compose.yml -f docker-compose.mock.yml

.PHONY: setup backend frontend dev test test-backend test-frontend lint e2e e2e-gitlab gitlab-mock up down logs reset-workspace check \
	preflight preflight-integration integration-up test-live readiness mock-up mock-down mock-e2e mock-readiness mock-logs

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

e2e: ## Browser E2E: offline stack at E2E_BASE_URL (default :5173, `make up`) + a self-started GitLab-mock stack
	cd frontend && npx playwright test

e2e-gitlab: ## Only the GitLab-mock lifecycle scenarios (starts the loopback GitLab TEST DOUBLE itself)
	cd frontend && npx playwright test --project=gitlab-mock

gitlab-mock: ## Run the loopback GitLab TEST DOUBLE on :8929 (not GitLab; for manual exploration)
	cd backend && ../$(PY) -m tests.support.gitlab_mock --port 8929

check: lint test ## Everything that runs without a started stack

up: ## Build and start the offline demo with Docker Compose
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f

reset-workspace: ## Delete local derived state and re-seed synthetic fixtures on next start
	rm -rf workspace

preflight: ## Offline check of the current configuration (no network connections)
	cd backend && ../$(PY) -m app.preflight

readiness: ## Opt-in READ-ONLY probe of the configured integrations (contacts them; never writes)
	cd backend && ../$(PY) -m app.readiness

mock-up: ## integration_mock profile: app + stateful GitLab/MCP/Confluence TEST DOUBLES (UI :5174)
	$(COMPOSE_MOCK) up --build -d

mock-e2e: ## Scripted full scenario inside the integration_mock network (needs `make mock-up`)
	$(COMPOSE_MOCK) --profile tools run --rm mock-scenario

mock-readiness: ## Readiness probe from inside the integration_mock backend container
	$(COMPOSE_MOCK) exec backend python -m app.readiness

mock-logs:
	$(COMPOSE_MOCK) logs -f

mock-down: ## Stop the integration_mock profile and drop its volume
	$(COMPOSE_MOCK) --profile tools down -v

preflight-integration: ## Offline check of $(INTEGRATION_ENV) inside the container (needs SKH_SECRETS_DIR)
	$(COMPOSE_INTEGRATION) run --rm --no-deps backend python -m app.preflight

integration-up: ## Start against the TEST GitLab/Confluence MCP (only after approval; needs SKH_SECRETS_DIR)
	$(COMPOSE_INTEGRATION) up --build -d

test-live: ## Read-only smoke tests against the configured TEST environment (explicit opt-in)
	cd backend && SKH_LIVE_TESTS=1 ../$(PY) -m pytest -m live tests/live -v
