# Developer shortcuts. Every target has an equivalent plain command in README.md.
PYTHON ?= python3.12
VENV := .venv
PY := $(VENV)/bin/python

INTEGRATION_ENV ?= deploy/integration/integration.env
COMPOSE_INTEGRATION = docker compose --env-file $(INTEGRATION_ENV) -f docker-compose.yml -f docker-compose.integration.yml
# integration_mock profile: separate compose project + volume, UI on 127.0.0.1:5174, doubles not published.
COMPOSE_MOCK = FRONTEND_PORT=5174 docker compose -p skh-mock -f docker-compose.yml -f docker-compose.mock.yml
# Personal test stack with the EXPERIMENTAL Claude Code CLI provider (docs/CLAUDE_CODE_CLI_INTEGRATION.md).
CLAUDE_TEST_ENV ?= deploy/claude-test/claude-test.env
COMPOSE_CLAUDE_TEST = docker compose -p semantic-kb-claude-test --env-file $(CLAUDE_TEST_ENV) -f docker-compose.yml -f docker-compose.claude-test.yml

.PHONY: setup backend frontend dev test test-backend test-frontend lint e2e e2e-gitlab gitlab-mock up down logs reset-workspace check \
	mock-kb-validate mock-kb-sync knowledge-eval knowledge-demo knowledge-eval-live work-eval \
	preflight preflight-integration integration-up test-live readiness mock-up mock-down mock-e2e mock-readiness mock-logs \
	claude-test-up claude-test-down claude-test-ps claude-test-logs claude-test-check claude-test-restart-worker

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
	cd backend && ../$(PY) -m ruff check app claude_worker tests && ../$(PY) -m ruff format --check app claude_worker tests && ../$(PY) -m mypy app claude_worker
	cd frontend && npx tsc --noEmit -p tsconfig.json && npx eslint .

e2e: ## Browser E2E: offline stack at E2E_BASE_URL (default :5173, `make up`) + a self-started GitLab-mock stack
	cd frontend && npx playwright test

e2e-gitlab: ## Only the GitLab-mock lifecycle scenarios (starts the loopback GitLab TEST DOUBLE itself)
	cd frontend && npx playwright test --project=gitlab-mock

gitlab-mock: ## Run the loopback GitLab TEST DOUBLE on :8929 (not GitLab; for manual exploration)
	cd backend && ../$(PY) -m tests.support.gitlab_mock --port 8929

check: lint test ## Everything that runs without a started stack

# --- M5.6.2: synthetic knowledge base, evaluation ---------------------------------------------------------
mock-kb-validate: ## Validate the synthetic base (frontmatter, links, chains, synthetic, secrets) → reports/knowledge-eval/validation.json
	cd backend && ../$(PY) -m app.tools.kb_validate ../fixtures/knowledge --strict-synthetic --json ../reports/knowledge-eval/validation.json

mock-kb-sync: ## Sync fixtures/knowledge into ./workspace/knowledge (only files it owns; local edits are kept)
	cd backend && ../$(PY) -m app.tools.kb_sync --fixtures ../fixtures/knowledge --workspace ../workspace/knowledge --apply

knowledge-eval: ## Deterministic evaluation (no LLM, no network): 216 gold cases → reports/knowledge-eval/after*
	cd backend && ../$(PY) -m app.evaluation.knowledge_eval --kb ../fixtures/knowledge --cases ../fixtures/eval --label after --out ../reports/knowledge-eval

work-eval: ## Deterministic M6 work evaluation (no AI, no network): acceptance oracles → reports/m6/work-eval/
	cd backend && ../$(PY) -m app.evaluation.work_eval --out ../reports/m6/work-eval

knowledge-demo: ## Five lifecycle demos (add/update/delete/relation/template) + example answer traces → reports/knowledge-eval/
	cd backend && ../$(PY) -m app.evaluation.lifecycle_demo --out ../reports/knowledge-eval

knowledge-eval-live: ## OPT-IN: SKH_LIVE_EVAL=1 SKH_EVAL_BASE_URL=http://127.0.0.1:5180 — assistant cases against a running stack
	@test "$$SKH_LIVE_EVAL" = "1" || (echo "live evaluation is opt-in: set SKH_LIVE_EVAL=1 and SKH_EVAL_BASE_URL" && exit 2)
	cd backend && ../$(PY) -m app.evaluation.live_eval --base-url "$$SKH_EVAL_BASE_URL" --cases ../fixtures/eval --out ../reports/knowledge-eval

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

claude-test-up: ## PERSONAL TEST: app + isolated Claude Code CLI worker (UI on 127.0.0.1:$$FRONTEND_PORT, default 5180)
	$(COMPOSE_CLAUDE_TEST) up --build -d

claude-test-ps:
	$(COMPOSE_CLAUDE_TEST) ps

claude-test-logs:
	$(COMPOSE_CLAUDE_TEST) logs -f

claude-test-check: ## One real request through the worker's CLI (prints only the outcome)
	$(COMPOSE_CLAUDE_TEST) exec claude-worker python -m claude_worker check

claude-test-restart-worker: ## Pick up a new token file
	$(COMPOSE_CLAUDE_TEST) restart claude-worker

claude-test-down: ## Stop the personal test stack (keeps its volume with the SQLite state)
	$(COMPOSE_CLAUDE_TEST) down
