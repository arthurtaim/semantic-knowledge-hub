#!/usr/bin/env bash
# Deploy or update the PERSONAL TEST stack (Claude Code CLI provider) on the test server.
# Run ON THE SERVER as root. Idempotent. Touches only /opt/semantic-kb-claude-test and the compose project
# `semantic-kb-claude-test`; other compose projects, containers, networks and firewall rules are not touched.
#
#   ROOT=/opt/semantic-kb-claude-test BRANCH=feature/claude-cli-personal-test ./deploy.sh [<commit-or-branch>]
set -euo pipefail

ROOT=${ROOT:-/opt/semantic-kb-claude-test}
BRANCH=${BRANCH:-feature/claude-cli-personal-test}
REPO_URL=${REPO_URL:-git@github.com:arthurtaim/semantic-knowledge-hub.git}
DEPLOY_KEY=${DEPLOY_KEY:-$ROOT/deploy_key}       # read-only GitHub deploy key for this repository only
TARGET=${1:-origin/$BRANCH}
APP=$ROOT/app
SECRETS=$ROOT/secrets
WORKER_UID=10002                                   # claudeworker user in deploy/claude-worker/Dockerfile
PROJECT=semantic-kb-claude-test

# Code must stay readable by the non-root container users (backend uid 10001, worker uid 10002): umask 022.
# Only the stack root (700) and the token directory (700/600) are restricted, explicitly below.
umask 022
mkdir -p "$ROOT"
chmod 700 "$ROOT"

# Token directory: only the worker user may read it; the token itself is installed with install-token.sh.
mkdir -p "$SECRETS"
touch "$SECRETS/claude_code_oauth_token"
chown -R "$WORKER_UID:$WORKER_UID" "$SECRETS"
chmod 700 "$SECRETS"
chmod 600 "$SECRETS/claude_code_oauth_token"

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$ROOT/known_hosts -o StrictHostKeyChecking=accept-new"
if [ ! -d "$APP/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP"
  git -C "$APP" config core.sshCommand "$GIT_SSH_COMMAND"
fi
git -C "$APP" config core.sshCommand "$GIT_SSH_COMMAND"
git -C "$APP" fetch --prune origin
CURRENT=$(git -C "$APP" rev-parse HEAD)
git -C "$APP" checkout --quiet --detach "$TARGET"
NEW=$(git -C "$APP" rev-parse HEAD)
# Repair files written by an earlier run with a restrictive umask (they would be unreadable in the images).
(cd "$APP" && git ls-files -z | xargs -0 chmod go+r)
if [ "$CURRENT" != "$NEW" ]; then
  echo "$CURRENT" > "$ROOT/previous_commit"      # used by rollback.sh
fi
echo "deploying $(git -C "$APP" log -1 --format='%h %s')"

ENV_FILE=$APP/deploy/claude-test/claude-test.env
if [ ! -f "$ENV_FILE" ]; then
  sed "s#^SKH_CLAUDE_SECRETS_DIR=.*#SKH_CLAUDE_SECRETS_DIR=$SECRETS#" \
    "$APP/deploy/claude-test/claude-test.env.example" > "$ENV_FILE"
fi

cd "$APP"
deploy/claude-test/stack.sh up --build -d --remove-orphans

for _ in $(seq 1 60); do
  state=$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-backend-1" 2>/dev/null || true)
  [ "$state" = "healthy" ] && break
  sleep 2
done
deploy/claude-test/stack.sh ps
echo "UI: http://127.0.0.1:$(grep -E '^FRONTEND_PORT=' "$ENV_FILE" | cut -d= -f2) on the server (open it through: ssh -N -L 5180:127.0.0.1:5180 root@<host>)"
