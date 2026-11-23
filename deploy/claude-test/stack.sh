#!/usr/bin/env bash
# `docker compose` for the PERSONAL TEST stack only (project semantic-kb-claude-test). Examples:
#   deploy/claude-test/stack.sh ps
#   deploy/claude-test/stack.sh logs -f claude-worker
#   deploy/claude-test/stack.sh exec -T claude-worker python -m claude_worker check
#   deploy/claude-test/stack.sh restart claude-worker
# With SKH_PUBLIC_ACCESS=true in the env file the public gateway (docker-compose.claude-public.yml) is included.
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=${CLAUDE_TEST_ENV:-deploy/claude-test/claude-test.env}
FILES=(-f docker-compose.yml -f docker-compose.claude-test.yml)
if grep -qE '^SKH_PUBLIC_ACCESS=true' "$ENV_FILE" 2>/dev/null; then
  FILES+=(-f docker-compose.claude-public.yml)
fi
exec docker compose -p semantic-kb-claude-test --env-file "$ENV_FILE" "${FILES[@]}" "$@"
