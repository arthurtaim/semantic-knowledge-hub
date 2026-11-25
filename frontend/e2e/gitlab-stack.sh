#!/bin/sh
# Starts the backend in INTEGRATION_PROFILE=integration_mock against three loopback TEST DOUBLES
# (backend/tests/support): GitLab REST subset (:8929), Confluence MCP (:8930) and Confluence Data Center
# REST (:8931, publication). Writes go only to those doubles. No external network, no real credentials.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$ROOT/workspace/e2e-gitlab"
rm -rf "$STATE" && mkdir -p "$STATE"
cd "$ROOT/backend"
export APP_ENV=test APP_HOST=127.0.0.1 APP_PORT=8011 AUTH_MODE=local_demo
export INTEGRATION_PROFILE=integration_mock
export KNOWLEDGE_BACKEND=gitlab SEED_FIXTURES=false LOCAL_KNOWLEDGE_DIR="$STATE/unused"
export GITLAB_URL=http://127.0.0.1:8929 GITLAB_ALLOW_INSECURE_HTTP=true GITLAB_PROJECT_ID=4242
export GITLAB_TOKEN=mock-gitlab-token-not-a-secret GITLAB_KNOWLEDGE_PATH=docs GITLAB_DEFAULT_BRANCH=main
export GITLAB_PROPOSALS_ENABLED=true GITLAB_REFRESH_SECONDS=0 GITLAB_TIMEOUT_SECONDS=2
export SEARCH_INDEX_PATH="$STATE/search.sqlite3" APP_STATE_PATH="$STATE/app_state.sqlite3"
export PUBLICATION_STATE_PATH="$STATE/publications.sqlite3"
# Every state file stays in $STATE — never the developer's ./workspace (test_e2e_stack_isolation.py).
export WORK_STATE_PATH="$STATE/work.sqlite3" CONFLUENCE_MOCK_STATE_PATH="$STATE/mock_confluence_state.json"
export CONFLUENCE_CONNECTOR=mcp CONFLUENCE_MCP_URL=http://127.0.0.1:8930/mcp CONFLUENCE_MCP_ALLOW_INSECURE_HTTP=true
export CONFLUENCE_MCP_AUTH_TOKEN=mock-mcp-token-not-a-secret CONFLUENCE_MCP_TIMEOUT_SECONDS=2 CONFLUENCE_MCP_STATUS_TTL_SECONDS=0
export CONFLUENCE_ALLOWLISTED_SPACES=TEST,ARCH CONFLUENCE_LINK_HOSTS=confluence.mock.example
export CONFLUENCE_WEB_BASE_URL=https://confluence.mock.example
export CONFLUENCE_MCP_TOOL_MAP='{"search":{"tool":"kb_search_pages","query_arg":"query","limit_arg":"limit","spaces_arg":"spaces"},"read":{"tool":"kb_read_page","id_arg":"page_id"}}'
export CONFLUENCE_MCP_RESULT_MAP='{"items":"results","id":"content.id","space":"content.space.key","title":"content.title","url":"content._links.webui","version":"content.version.number","updated":"content.version.when","body":["excerpt","body.storage.value"]}'
export CONFLUENCE_REST_URL=http://127.0.0.1:8931/confluence CONFLUENCE_REST_ALLOW_INSECURE_HTTP=true
export CONFLUENCE_REST_TOKEN=mock-confluence-publish-token-not-a-secret CONFLUENCE_REST_TIMEOUT_SECONDS=2
export CONFLUENCE_TARGET_SPACE=SKHTEST CONFLUENCE_PARENT_PAGE_ID=5000001 CONFLUENCE_PUBLISH_ENABLED=true
export AI_PROVIDER=mock APP_PUBLIC_URL=http://127.0.0.1:5175
exec ../.venv/bin/python -m app
