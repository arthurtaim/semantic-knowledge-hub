#!/bin/sh
# Starts the backend in KNOWLEDGE_BACKEND=gitlab mode against the loopback GitLab TEST DOUBLE
# (backend/tests/support/gitlab_mock.py). Confluence MCP points to a loopback port where nothing
# listens: the "MCP unavailable" scenario. No external network, no real credentials.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$ROOT/workspace/e2e-gitlab"
rm -rf "$STATE" && mkdir -p "$STATE"
cd "$ROOT/backend"
export APP_ENV=test APP_HOST=127.0.0.1 APP_PORT=8011 AUTH_MODE=local_demo
export KNOWLEDGE_BACKEND=gitlab SEED_FIXTURES=false LOCAL_KNOWLEDGE_DIR="$STATE/unused"
export GITLAB_URL=http://127.0.0.1:8929 GITLAB_ALLOW_INSECURE_HTTP=true GITLAB_PROJECT_ID=4242
export GITLAB_TOKEN=mock-gitlab-token-not-a-secret GITLAB_KNOWLEDGE_PATH=docs GITLAB_DEFAULT_BRANCH=main
export GITLAB_PROPOSALS_ENABLED=true GITLAB_REFRESH_SECONDS=0 GITLAB_TIMEOUT_SECONDS=2
export SEARCH_INDEX_PATH="$STATE/search.sqlite3" APP_STATE_PATH="$STATE/app_state.sqlite3"
export CONFLUENCE_CONNECTOR=mcp CONFLUENCE_MCP_URL=http://127.0.0.1:8930/mcp CONFLUENCE_MCP_ALLOW_INSECURE_HTTP=true
export CONFLUENCE_ALLOWLISTED_SPACES=SKHTEST CONFLUENCE_MCP_TIMEOUT_SECONDS=2
export CONFLUENCE_MCP_TOOL_MAP='{"search":{"tool":"search_pages","query_arg":"query"},"read":{"tool":"get_page","id_arg":"page_id"}}'
export AI_PROVIDER=mock APP_PUBLIC_URL=http://127.0.0.1:5175
exec ../.venv/bin/python -m app
