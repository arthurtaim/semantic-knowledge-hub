#!/usr/bin/env bash
# Roll the PERSONAL TEST stack back to the previously deployed commit (or to the commit given as $1).
# Run ON THE SERVER as root. The SQLite state volume is kept.
#
#   ./rollback.sh               # previous commit recorded by deploy.sh
#   ./rollback.sh <commit-sha>  # any commit of the repository
set -euo pipefail
ROOT=${ROOT:-/opt/semantic-kb-claude-test}
TARGET=${1:-$(cat "$ROOT/previous_commit" 2>/dev/null || true)}
if [ -z "$TARGET" ]; then
  echo "No previous commit recorded; pass a commit SHA." >&2
  exit 1
fi
exec "$(dirname "$0")/deploy.sh" "$TARGET"
