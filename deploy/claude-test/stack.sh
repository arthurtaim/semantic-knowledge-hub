#!/usr/bin/env bash
# `docker compose` for the PERSONAL TEST stack only (project semantic-kb-claude-test). Examples:
#   deploy/claude-test/stack.sh ps
#   deploy/claude-test/stack.sh logs -f claude-worker
#   deploy/claude-test/stack.sh exec -T claude-worker python -m claude_worker check
#   deploy/claude-test/stack.sh restart claude-worker
set -euo pipefail
cd "$(dirname "$0")/../.."
exec docker compose -p semantic-kb-claude-test --env-file "${CLAUDE_TEST_ENV:-deploy/claude-test/claude-test.env}" \
  -f docker-compose.yml -f docker-compose.claude-test.yml "$@"
