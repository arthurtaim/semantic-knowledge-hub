#!/usr/bin/env bash
# Run on YOUR computer (where you can log in to claude.ai in a browser):
#   1) creates a long-lived Claude Code token with the OFFICIAL `claude setup-token` (subscription login);
#   2) asks you to paste it (hidden input — not echoed, not stored in shell history);
#   3) writes it over SSH to the server's dedicated token file (owner = worker user, mode 600);
#   4) restarts only the worker of the personal test stack and runs one real check.
#
#   deploy/claude-test/install-token.sh root@<host>
#
# The token never enters git, the backend, the browser or logs. Revoke it at claude.ai (Settings → Claude Code)
# when the personal test is over.
set -euo pipefail
HOST=${1:?usage: install-token.sh root@<host>}
ROOT=${ROOT:-/opt/semantic-kb-claude-test}

if command -v claude >/dev/null 2>&1; then
  echo "Шаг 1. Откроется вход в claude.ai; после подтверждения CLI покажет токен (sk-ant-oat01-…)."
  claude setup-token
else
  echo "Claude Code CLI не найден на этом компьютере: выполните \`claude setup-token\` там, где он установлен."
fi

read -rsp "Шаг 2. Вставьте токен (ввод скрыт) и нажмите Enter: " TOKEN
echo
if [[ ! $TOKEN =~ ^[A-Za-z0-9._~+/=-]{20,4096}$ ]]; then
  echo "Строка не похожа на токен Claude Code — ничего не записано." >&2
  exit 1
fi

printf '%s' "$TOKEN" | ssh "$HOST" "set -e; umask 077; f=$ROOT/secrets/claude_code_oauth_token; \
  cat > \"\$f.new\"; chown 10002:10002 \"\$f.new\"; chmod 600 \"\$f.new\"; mv \"\$f.new\" \"\$f\"; \
  cd $ROOT/app && deploy/claude-test/stack.sh restart claude-worker >/dev/null && sleep 5 && \
  deploy/claude-test/stack.sh exec -T claude-worker python -m claude_worker check"
unset TOKEN
echo "Шаг 3. Токен установлен; результат проверки — выше (check_ok)."
