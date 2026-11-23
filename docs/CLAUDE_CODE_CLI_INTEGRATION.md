# Claude Code CLI как временный AI-провайдер (личный тест)

> **Статус: экспериментально, только для личного тестирования владельцем подписки.** Провайдер `claude_cli`
> не является корпоративным AI-контуром и не заменяет GigaCode. Он работает только на синтетических данных,
> для одного оператора, через приватный канал (SSH-туннель). Включать его для других пользователей, публиковать
> в интернете или отправлять через него банковские данные нельзя.

## 1. Зачем и что это

Цель — проверить «живую» языковую модель в Semantic Knowledge Hub (ответы с цитатами, диалог, AI-черновики)
до появления утверждённого корпоративного провайдера. Для этого используется уже оплаченная подписка
Claude владельца через **Claude Code CLI** в неинтерактивном режиме:

```bash
claude -p --output-format stream-json --verbose --include-partial-messages …
```

Приложение по-прежнему зависит только от контракта `AIProvider` (`backend/app/adapters/ai/base.py`).
`ClaudeCodeCLIProvider` — ещё одна его реализация рядом с `MockAIProvider` (по умолчанию) и
`OpenAICompatibleAIProvider` (`internal_api`). Переход на GigaCode — это новая реализация того же контракта
(§11), без изменения хранилища знаний, поиска, проверки цитат и UI.

## 2. Claude Code CLI и Anthropic API — в чём разница

| | Claude Code CLI (`claude_cli`) | Anthropic API |
|---|---|---|
| Авторизация | подписка Claude (Pro/Max) владельца: OAuth-токен из официального `claude setup-token` | API-ключ организации (`ANTHROPIC_API_KEY`), оплата по токенам |
| Назначение | инструмент разработчика; здесь — личный эксперимент одного человека | программная интеграция в продукты и сервисы |
| Многопользовательский сервис | **нельзя**: подписочная авторизация предназначена для личного использования владельцем | да, по условиям API |
| Как вызывается | отдельный процесс CLI на каждый запрос (stdin → NDJSON-события) | HTTP-запросы к API |
| Инструменты | у CLI есть собственные инструменты (Bash, файлы, веб) — **здесь все выключены** (§6) | только то, что передаёт приложение |

API-ключ Anthropic в этом проекте **не используется**. Флаг `--bare` не применяется: в Claude Code 2.1.318 он
принимает только `ANTHROPIC_API_KEY`/`apiKeyHelper` и игнорирует OAuth-авторизацию подписки.

## 3. Архитектура

```text
Браузер владельца ──ssh -L 5180──▶ frontend (nginx, 127.0.0.1:5180 на сервере)
                                     │ /api
                                     ▼
                        backend (FastAPI) — сеть internal + ai, БЕЗ выхода в интернет, без учётных данных Claude
                          AssistantService / AuthoringService
                            └─ ClaudeCodeCLIProvider ──HTTP NDJSON (сеть ai, только backend↔worker)──┐
                                                                                                      ▼
                        claude-worker (отдельный контейнер, read-only FS, uid 10002, cap_drop ALL)
                          backend/claude_worker: semaphore → subprocess без shell:
                          claude -p --output-format stream-json --tools "" --restricted --strict-mcp-config …
                            │  токен: файл /run/secrets/claude/claude_code_oauth_token (только для дочернего процесса)
                            │  HTTPS_PROXY (сеть egress-proxy, внутренняя)
                            ▼
                        egress-proxy (тот же образ): пропускает только CONNECT api.anthropic.com:443
                            ▼
                          HTTPS → Anthropic (выход в интернет есть только у egress-proxy)
```

- **Backend** собирает авторизованные фрагменты (как для любого провайдера), формирует сообщение с вопросом,
  фрагментами и историей **как данными** и отправляет его воркеру. Системный промпт — фиксированный текст в коде.
- **Воркер** (`backend/claude_worker/`) — минимальный сервис без доступа к базе знаний, GitLab, Confluence и
  данным приложения. На каждый запрос: пустой временный каталог, минимальное окружение, процесс CLI в своей
  группе процессов; после ответа каталог удаляется.
- Ответ проходит **ту же серверную проверку цитат**: цитата засчитывается, только если она дословно есть в
  переданном фрагменте; ссылки на несуществующие фрагменты отбрасываются; при недостатке данных текст модели
  не показывается (используется фиксированная фраза «Недостаточно данных…»).

Файлы: `backend/app/adapters/ai/claude_cli.py` (провайдер), `backend/claude_worker/` (воркер),
`deploy/claude-worker/Dockerfile`, `docker-compose.claude-test.yml`, `deploy/claude-test/*`,
тесты `backend/tests/test_claude_cli_worker.py`, `test_claude_cli_provider.py`, `tests/live/test_claude_cli_live.py`,
mock CLI `backend/tests/support/fake_claude_cli.py`.

## 4. Потоковые ответы, диалог, отмена

- `POST /api/assistant/ask/stream` — NDJSON-события: `status` (`retrieving` → `generating` → `validating`),
  `delta` (**предварительный** текст модели, ещё не проверенный), затем ровно одно событие `final` (тот же
  проверенный `AskResponse`, что у `/api/assistant/ask`) или `error` (`code`, `message`, `status`).
  UI показывает предварительный текст отдельно с пометкой «цитаты ещё не проверены» и заменяет его проверенным
  ответом. Блок источников модели (после маркера `<<<EVIDENCE>>>`) в поток не попадает.
- **Диалог.** Сервер не хранит переписку: клиент присылает до 6 предыдущих реплик (`history`), они передаются
  модели как данные и **не являются источниками**. Каждый запрос — отдельный процесс CLI с
  `--no-session-persistence`, поэтому сессии разных диалогов не смешиваются. Поиск для уточняющего вопроса
  учитывает предыдущий вопрос.
- **Отмена.** Закрытие соединения (кнопка «Отменить» в UI) закрывает цепочку генераторов до воркера, и воркер
  завершает группу процессов CLI (SIGTERM, через 3 с SIGKILL).
- **Таймауты.** Ответ — `CLAUDE_CLI_TIMEOUT_SECONDS` (120 с), черновик — `CLAUDE_CLI_DRAFT_TIMEOUT_SECONDS`
  (240 с); воркер не допускает больше `CLAUDE_WORKER_MAX_TIMEOUT_SECONDS` (300 с); nginx ждёт до 300 с.
- **Ограничение одновременных запросов.** `CLAUDE_WORKER_MAX_CONCURRENCY` (по умолчанию 1); лишний запрос
  сразу получает `ai_busy` (HTTP 429 у `/ask`) — запрос пользователя в UI сохраняется.
- **AI-черновики.** `POST /api/authoring/ai-draft` с `claude_cli`: шаблон и утверждённые документы команды
  передаются как данные, модель возвращает Markdown и список выдержек; каждая выдержка перепроверяется
  `AuthoringService`. Результат — только предложение: он не сохраняется сам, AI-черновик нельзя утвердить
  (`ai_cannot_approve`), дальше обычный путь ревью и MR.

## 5. Обработка ошибок

| Код | HTTP | Когда | Что видит пользователь |
|---|---|---|---|
| `ai_cli_unavailable` | 503 | воркер недоступен или в нём нет CLI | «Воркер Claude Code недоступен» |
| `ai_auth_failed` | 503 | нет токена, токен истёк/отозван (`authentication_failed`) | «Авторизация Claude Code отсутствует или истекла…» |
| `ai_rate_limited` | 503 | лимит подписки | «Лимит запросов подписки Claude исчерпан…» |
| `ai_timeout` | 503 | превышен таймаут | «Claude Code не ответил за N с» |
| `ai_busy` | 429 | занят другой запрос | «Claude Code уже обрабатывает запрос…» |
| `ai_tool_use_blocked`, `ai_unsafe_cli_config` | 502 | CLI объявил инструменты / попытался их вызвать | запрос прерван |
| `ai_invalid_response`, `ai_upstream_error` | 502 | неожиданный формат / ошибка CLI | общая ошибка |

Текст stderr и ответы CLI об ошибках пользователю и в журналы не передаются — только код и фиксированное
сообщение. При любой ошибке вопрос остаётся в поле ввода.

## 6. Ограничения безопасности

- **Нет инструментов.** `--tools ""` (все встроенные инструменты выключены), `--restricted` (нет инструментов,
  выполняющих код, нет WebFetch; пользовательские/проектные настройки и их hooks игнорируются),
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (нет MCP-серверов), `--disable-slash-commands`,
  `--no-session-persistence`, `--permission-mode dontAsk` (всё, что не разрешено заранее, запрещено).
- **Контроль по факту.** Воркер прерывает запуск, если событие `init` сообщает хотя бы один инструмент или
  MCP-сервер, если начат блок `tool_use` или если в результате есть `permission_denials`.
- **Без shell.** `asyncio.create_subprocess_exec` со списком аргументов; запрос — через stdin (не в argv).
- **Изоляция процесса.** Пустой каталог на запрос; окружение — белый список (`PATH`, `HOME`, `CLAUDE_CONFIG_DIR`,
  `LANG`, `TMPDIR`, флаги отключения автообновления/телеметрии и сам токен); секреты приложения не передаются.
- **Изоляция контейнера.** Воркер: read-only root FS, tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`,
  лимиты памяти/CPU/процессов, без опубликованного порта, без Docker socket, без домашнего каталога root;
  смонтирован только отдельный каталог с одним файлом токена (read-only). Сеть `ai` связывает только backend и
  воркер. У самого воркера нет маршрута наружу: CLI выходит только через `egress-proxy` (`HTTPS_PROXY`), который
  туннелирует исключительно `CONNECT api.anthropic.com:443` (`EGRESS_ALLOWED_HOSTS`) и отклоняет IP-адреса, другие
  хосты и порты — в том числе сервисы других проектов на сервере. Backend по-прежнему без выхода в интернет.
- **Данные как данные.** Вопрос, фрагменты и история — в пользовательском сообщении внутри разделителей,
  метаданные фрагментов в JSON; разделители из текста источников нейтрализуются. Системный промпт фиксирован.
- **Секреты.** Токен читается из файла в момент запуска дочернего процесса, не попадает в API, браузер, журналы
  и Git (`.gitignore`: `deploy/claude-test/*.env`, `claude_code_oauth_token`). Статус показывает только
  источник авторизации (`token_file`/`config_dir`/`none`), без адреса почты и организации.
- **Fail closed при старте.** `AI_PROVIDER=claude_cli` не запустится без `CLAUDE_CLI_PERSONAL_USE_ACK=true`,
  вне `AUTH_MODE=local_demo`, в профиле `offline` или с адресом воркера, который не loopback и не имя внутреннего
  Docker-сервиса.

Модель физически не может выполнить команду, прочитать или изменить файлы сервера, обратиться к другому
приложению, GitLab или Confluence: у процесса нет инструментов, а backend не даёт ему ничего, кроме текста.

## 7. Настройка

| Переменная | Где | По умолчанию | Назначение |
|---|---|---|---|
| `AI_PROVIDER` | backend | `mock` | `claude_cli` включает провайдер |
| `CLAUDE_CLI_PERSONAL_USE_ACK` | backend | `false` | явное подтверждение личного использования |
| `CLAUDE_CLI_WORKER_URL` | backend | — | `http://claude-worker:8090` (Docker) или `http://127.0.0.1:8090` |
| `CLAUDE_CLI_TIMEOUT_SECONDS` / `CLAUDE_CLI_DRAFT_TIMEOUT_SECONDS` | backend | 120 / 240 | таймауты ответа и черновика |
| `INTEGRATION_PROFILE` | backend | `offline` | для личного теста — `live_read_only` (CLI ходит во внешний сервис) |
| `CLAUDE_CODE_OAUTH_TOKEN_FILE` | worker | — | файл с токеном `claude setup-token` |
| `CLAUDE_CLI_MODEL` | worker | пусто | алиас модели для CLI (пусто — модель подписки по умолчанию) |
| `CLAUDE_WORKER_MAX_CONCURRENCY` | worker | 1 | одновременные запросы |
| `CLAUDE_CLI_COMMAND` | worker | `claude` | команда CLI (в образе `/usr/local/bin/claude`) |
| `CLAUDE_WORKER_EGRESS_PROXY` | worker | пусто | прокси для CLI (`http://egress-proxy:3128` в стенде) |
| `EGRESS_ALLOWED_HOSTS` | egress-proxy | `api.anthropic.com` | единственные хосты, куда разрешён выход (порт 443) |

Шаблон для стенда — `deploy/claude-test/claude-test.env.example` (секретов не содержит).

## 8. Личный тестовый контур на сервере

Отдельный compose-проект `semantic-kb-claude-test` в `/opt/semantic-kb-claude-test`: свои контейнеры, тома,
сети, порт `127.0.0.1:5180`, лимиты (worker 900 MB/1 CPU, backend 448 MB/0,75 CPU, frontend 96 MB/0,25 CPU,
egress-proxy 64 MB/0,25 CPU).
Другие проекты на сервере не затрагиваются.

```bash
# на сервере (root), один раз: deploy key только для чтения этого репозитория → /opt/semantic-kb-claude-test/deploy_key
deploy/claude-test/deploy.sh                      # клонирование/обновление ветки, сборка, запуск
deploy/claude-test/stack.sh ps                    # состояние контейнеров проекта
deploy/claude-test/stack.sh logs -f claude-worker # журналы (без промптов, ответов и токенов)

# на своём компьютере
deploy/claude-test/install-token.sh root@<host>   # claude setup-token → скрытый ввод → файл токена на сервере → проверка
ssh -N -L 5180:127.0.0.1:5180 root@<host>          # туннель; UI: http://127.0.0.1:5180
SKH_LIVE_TESTS=1 SKH_CLAUDE_LIVE_URL=http://127.0.0.1:5180 \
  backend/.venv/bin/python -m pytest -m live backend/tests/live/test_claude_cli_live.py   # opt-in smoke
```

Проверка авторизации без UI: `deploy/claude-test/stack.sh exec -T claude-worker python -m claude_worker check`
(выводит только `check_ok`, код и длительность).

**Публичная ссылка (по решению владельца).** Чтобы открыть стенд из любого браузера без SSH-туннеля, в
`deploy/claude-test/claude-test.env` включается `SKH_PUBLIC_ACCESS=true` (плюс `SKH_PUBLIC_IP`, `SKH_PUBLIC_HOST`,
`SKH_PUBLIC_AUTH_DIR`). Тогда `stack.sh` добавляет `docker-compose.claude-public.yml`: шлюз Caddy на портах 80/443
перед frontend.

- `http://<ip>/` и `https://<ip-через-дефисы>.sslip.io/` (сертификат Let's Encrypt выпускается автоматически).
- Ссылка **открытая, без логина** (решение владельца для демо): любой, у кого есть адрес, может задавать вопросы,
  и запросы расходуют подписку Claude владельца. Вариант с логином — `SKH_PUBLIC_CADDYFILE=Caddyfile.login`
  (логин и пароль один раз генерирует `deploy.sh`, открытый текст — в `/opt/semantic-kb-claude-test/public-access.txt`).
- Само приложение по-прежнему слушает только loopback: шлюз передаёт запросы с `Host: 127.0.0.1`, поэтому проверки
  backend при старте и на каждом запросе не меняются.
- Выключить: `SKH_PUBLIC_ACCESS=false` и `deploy/claude-test/stack.sh up -d --remove-orphans`.

**Авторизация.** Токен создаётся только официальной командой `claude setup-token` (вход в claude.ai в браузере)
и хранится в одном файле `/opt/semantic-kb-claude-test/secrets/claude_code_oauth_token` (владелец — uid воркера,
права 600). Авторизационные файлы других проектов и пользователей не копируются и не монтируются. Отзыв —
в настройках claude.ai; после отзыва статус и ответы честно показывают `ai_auth_failed`.

**Обновление и откат.**

```bash
cd /opt/semantic-kb-claude-test/app && deploy/claude-test/deploy.sh            # последняя версия ветки
deploy/claude-test/deploy.sh <commit-sha>                                        # конкретная версия
deploy/claude-test/rollback.sh                                                   # предыдущая развёрнутая версия
```

Том с SQLite-состоянием (`semantic-kb-claude-test_workspace`) при обновлении и откате сохраняется.

## 9. Отключение Claude и возврат к Mock AI

- В `deploy/claude-test/claude-test.env` задать `SKH_AI_PROVIDER=mock`, затем `deploy/claude-test/stack.sh up -d`
  (воркер можно остановить: `stack.sh stop claude-worker`). Код не меняется.
- Локально и в офлайн-демо Mock AI остаётся значением по умолчанию: `AI_PROVIDER` не задан → `mock`.
- Если позже понадобится публичная демонстрация интерфейса, она должна работать отдельно и только с
  `AI_PROVIDER=mock` — без воркера и без токена.

## 10. Ограничения

- Нет пользователей: доступ через SSH-туннель или открытую публичную ссылку; нет SSO/RBAC —
  `docs/PRODUCTION_BLOCKERS.md`.
- Подписочная авторизация — для личного использования; провайдер нельзя превращать в общий AI-сервис.
- Запросы уходят в Anthropic: допустимы только синтетические данные (`fixtures/`).
- Холодный старт CLI добавляет несколько секунд к каждому ответу; длинные черновики — до нескольких минут.
- Предварительный поток показывает непроверенный текст модели (с явной пометкой); доказательной силой
  обладает только итоговый ответ после проверки цитат.

## 11. Переход на GigaCode

Ничего из этого не встроено в бизнес-логику: `AssistantService`, `AuthoringService`, поиск, проверка цитат и
UI работают с любым `AIProvider`. Для GigaCode после подтверждения его реального интерфейса (CLI, MCP или
внутренний API — `docs/GIGACODE_MIGRATION.md`) добавляется `GigaCodeProvider` с теми же методами (`answer`,
опционально `stream_answer`, `suggest_edit`, `draft_document`, `status`). Если GigaCode — CLI, можно
переиспользовать шаблон воркера (изолированный процесс, без инструментов, NDJSON); если HTTP API — шаблон
`OpenAICompatibleAIProvider`. Провайдер `claude_cli` после этого удаляется или остаётся выключенным.
