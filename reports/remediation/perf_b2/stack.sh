#!/bin/sh
# B2 sandbox stack: one backend (`python -m app`, one uvicorn process, mock AI, synthetic fixtures, all state files in
# $STATE_ROOT/stack-<name>) and, unless NO_VITE=1, a Vite dev server proxying to it. Kill the script to stop both.
# usage: REPO=<checkout> VENV=<venv> STATE_ROOT=<scratch dir> stack.sh <name> <backend_port> <vite_port> [ai=mock]
set -eu
NAME=$1; BP=$2; VP=$3; AI=${4:-mock}
REPO=${REPO:?set REPO to the checkout to run}
VENV=${VENV:-$REPO/.venv}
STATE_ROOT=${STATE_ROOT:?set STATE_ROOT to a scratch directory}
S=$STATE_ROOT/stack-$NAME
if [ "${KEEP:-0}" != "1" ]; then rm -rf "$S"; fi
mkdir -p "$S"
cd "$REPO/backend"
APP_ENV=test APP_HOST=127.0.0.1 APP_PORT=$BP AUTH_MODE=local_demo INTEGRATION_PROFILE=offline \
KNOWLEDGE_BACKEND=local LOCAL_KNOWLEDGE_DIR=$S/knowledge FIXTURES_DIR=$REPO/fixtures/knowledge \
SEED_FIXTURES=true LOCAL_CONTENT_IS_DEMO=true SEARCH_BACKEND=sqlite_fts \
SEARCH_INDEX_PATH=$S/search.sqlite3 APP_STATE_PATH=$S/app_state.sqlite3 PUBLICATION_STATE_PATH=$S/publications.sqlite3 \
WORK_STATE_PATH=$S/work.sqlite3 \
AI_PROVIDER=$AI CONFLUENCE_CONNECTOR=disabled APP_PUBLIC_URL=http://127.0.0.1:$VP \
  "$VENV/bin/python" -m app > "$S/backend.log" 2>&1 &
BPID=$!
echo $BPID > "$S/backend.pid"
VPID=""
if [ "${NO_VITE:-0}" != "1" ]; then
  cd "$REPO/frontend"
  SKH_BACKEND_URL=http://127.0.0.1:$BP FRONTEND_PORT=$VP npx vite --port "$VP" --strictPort > "$S/vite.log" 2>&1 &
  VPID=$!
fi
trap 'kill $BPID $VPID 2>/dev/null' INT TERM EXIT
wait
