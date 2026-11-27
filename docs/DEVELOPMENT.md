# Разработка и запуск

Как запустить прототип, проверить его и подключить тестовый контур. Для команды; обзор продукта — в
[README](../README.md), оглавление документации — [docs/README.md](README.md).

**Демо работает полностью офлайн на синтетических данных.** Не нужны доступы к GitLab, Confluence или AI API.

## Где что хранится

- **GitHub (этот репозиторий):** только код, тесты, конфигурация и синтетические примеры (`fixtures/`).
- **GitLab (отдельный репозиторий):** рабочая база знаний команды — каноническая версия документов.
- **Confluence Data Center:** корпоративная документация читается через утверждённый MCP (только чтение);
  утверждённые документы публикуются отдельным REST-адаптером с отдельным токеном.
- **Claude Code** — инструмент разработки прототипа; **GigaCode** — целевая агентная среда. Оба подключаются через
  адаптер `AIProvider`, логика приложения к ним не привязана.

Локальный каталог `workspace/` создаётся из `fixtures/knowledge` при первом запуске и игнорируется git.

## Быстрый старт (Docker)

Нужен Docker с Compose v2. Все команды выполняются **из корня репозитория**.

```bash
git clone <url-репозитория> semantic-knowledge-hub && cd semantic-knowledge-hub
docker compose up --build -d      # или: make up
```

Откройте <http://127.0.0.1:5173>.

- Порт публикуется только на `127.0.0.1` (переменная `BIND_ADDRESS`). При нелокальном адресе backend в режиме
  `local_demo` откажется стартовать.
- Backend наружу не публикуется и работает в сети без выхода в интернет.

```bash
docker compose ps          # оба сервиса running, backend — healthy
docker compose logs -f     # журналы без тел запросов и query string
docker compose down        # остановить (данные workspace остаются в томе)
docker compose down -v     # остановить и удалить том: при следующем старте фикстуры засеются заново
```

## Запуск без Docker

Нужны Python 3.12+ и Node.js 20.19+ (или 22+).

```bash
make setup      # .venv + зависимости backend (dev) + npm ci для frontend
make dev        # backend на 127.0.0.1:8000 и UI на 127.0.0.1:5173 одновременно
```

То же без `make`:

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.lock
.venv/bin/pip install --no-deps -e backend
(cd frontend && npm ci)

# терминал 1 — API (засевает ./workspace из fixtures при первом запуске)
cd backend && ../.venv/bin/python -m app
# терминал 2 — UI (проксирует /api на 127.0.0.1:8000)
cd frontend && npx vite
```

`python -m app` проверяет конфигурацию до старта. Небезопасная конфигурация не запустится (fail closed),
например:
- `AUTH_MODE=local_demo` на нелокальном адресе;
- `APP_ENV=production`;
- неразрешённый AI-хост;
- интеграции в профиле `offline`.

## Что посмотреть в демо

1. **Главная — ассистент.** Спросите `Где хранится каноническая база знаний команды?`: ответ из дословных
   выдержек с кликабельными цитатами и блоком «Источники». В режиме `AI_PROVIDER=mock` («ИИ: без модели») ответ
   без языковой модели; вопросы о состоянии системы («Сколько документов в базе?») требуют модели. Под заголовком
   ответа — тихая строка «Источники: синтетические (учебные)»: документы демо-базы синтетические.
2. **«Документы».** Дерево → «Интеграции / ARIS» → документ → предпросмотр. «Обзор» — 83 документа, из них
   12 требуют внимания; клик по числу открывает «Таблицу» с этим фильтром.
3. **Документ.** Строка статуса, свойства, вкладки Текст / Связи / История / Markdown; «Ещё» → «Применить
   шаблон»; «Предложить изменение» → diff → «Готово к ревью». Исходный документ не меняется.
4. **«Создать документ» → «Пустой документ».** Название и раздел → редактор: Markdown, `[[` для ссылок,
   предпросмотр → «Сохранить черновик» → «Отправить на ревью».
5. **«Карта знаний»** и **«Шаблоны»** (версии, сравнение версий).
6. **«Интеграции».** Локальная база подключена, внешние системы — «Не подключено», AI — «Без модели (mock)». Блок
   синхронизации индекса.
7. **«Проекты»** (группа «Работа»). Три синтетических проекта: ARIS → «Список», «Доска», «Гант»; карточка задачи
   ARIS-1 → «Документы» (в том числе устаревший документ с пометкой). Документ `DEMO-INT-002` → «Связи» → «Задачи».
   «AI план» появляется только с языковой моделью (в `mock` его нет).
8. **«Создать задачу» из чата.** На главной напишите «создай задачу в проекте RAG обновить витрину до 5 декабря» —
   появится карточка черновика; задачу создаёт кнопка «Создать задачу» (работает и без модели). С моделью доступны
   навыки «Проанализировать проект», «Составить план задач», «Предложить изменения задач»
   ([docs/WORK_CHAT_SKILLS.md](WORK_CHAT_SKILLS.md)).

В офлайн-режиме отправка в GitLab и публикация в Confluence не настроены — их можно посмотреть в профиле с
тестовыми дублями.

## Полный цикл на тестовых дублях (`integration_mock`)

Стек с **тестовыми дублями** GitLab REST, Confluence MCP и Confluence Data Center REST
(`backend/tests/support/*_mock.py`, образ `deploy/mocks/Dockerfile`).

- Это не GitLab и не Confluence.
- Дубли работают только во внутренней Docker-сети, без портов на хосте.
- Запись разрешена только потому, что все цели — объявленные дубли (`INTEGRATION_PROFILE=integration_mock`,
  `MOCK_SERVICE_HOSTS`).

```bash
make mock-up          # отдельный compose-проект skh-mock со своим томом; UI на http://127.0.0.1:5174
make mock-e2e         # сквозной сценарий: черновик → MR → merge → синхронизация → dry-run → публикация → обновление → конфликт
make mock-readiness   # read-only проверка интеграций изнутри backend (цели помечены «тестовый дубль»)
make mock-logs        # журналы
make mock-down        # остановить и удалить том профиля
```

Сценарий вручную на <http://127.0.0.1:5174>:
1. «Создать документ» или «Предложить изменение» → «Готово к ревью» → «Отправить в GitLab». Приложение
   создаёт ветку `kb/update/…`, коммит и Draft MR.
2. Merge в дубле GitLab. Порты дублей наружу не публикуются, поэтому merge выполняется изнутри контейнера.
   Номер MR (`<iid>`) показан на странице предложения:

   ```bash
   docker compose -p skh-mock -f docker-compose.yml -f docker-compose.mock.yml exec gitlab-mock \
     python -c "import httpx; print(httpx.post('http://127.0.0.1:8929/__mock__/merge-requests/<iid>/merge').text)"
   ```

3. «Проверить статус в GitLab» → «Принято (merge)», документ появляется в базе.
4. На странице документа, блок «Публикация в Confluence»: «Открыть предпросмотр» → «Опубликовать в Confluence».

Без Docker (loopback-стек, как в Playwright):

```bash
cd backend && ../.venv/bin/python -m tests.support.gitlab_mock --port 8929          # терминал 1: дубль GitLab
cd backend && ../.venv/bin/python -m tests.support.mcp_mock --port 8930             # терминал 2: дубль Confluence MCP
cd backend && ../.venv/bin/python -m tests.support.confluence_mock --port 8931 \
  --public-url http://127.0.0.1:8931/confluence                                     # терминал 3: дубль Confluence DC REST
sh frontend/e2e/gitlab-stack.sh                                                     # терминал 4: backend (integration_mock) на :8011
cd frontend && SKH_BACKEND_URL=http://127.0.0.1:8011 FRONTEND_PORT=5175 npx vite    # терминал 5: UI на :5175
```

Merge в дубле: `curl -X POST http://127.0.0.1:8929/__mock__/merge-requests/<iid>/merge`.

## Личный тест с Claude Code CLI (экспериментально)

Временный AI-провайдер `AI_PROVIDER=claude_cli`: ответы с цитатами, потоковый вывод, диалог и AI-черновики через
**Claude Code CLI с подпиской владельца**. CLI работает в изолированном контейнере-воркере без инструментов, MCP и
доступа к данным приложения. Это только личный тест: один оператор, синтетические данные, доступ через
SSH-туннель. Не корпоративный контур и не замена GigaCode.

```bash
cp deploy/claude-test/claude-test.env.example deploy/claude-test/claude-test.env   # без секретов
make claude-test-up                     # отдельный compose-проект semantic-kb-claude-test, UI на 127.0.0.1:5180
deploy/claude-test/install-token.sh root@<host>   # официальный `claude setup-token` → файл токена на сервере
ssh -N -L 5180:127.0.0.1:5180 root@<host>          # открыть http://127.0.0.1:5180
```

Публичная ссылка вместо туннеля — `SKH_PUBLIC_ACCESS=true` в `claude-test.env`: шлюз Caddy на 80/443
(`http://<ip>/`, `https://<ip>.sslip.io/`). Логин на всём сайте и API — `SKH_PUBLIC_CADDYFILE=Caddyfile.login`
(файл паролей вне git). Модель закрепляется `CLAUDE_CLI_MODEL` (например `claude-sonnet-5-5`), параллельность
воркера — `CLAUDE_WORKER_MAX_CONCURRENCY`. Обновление — `deploy/claude-test/deploy.sh` (по умолчанию `main`,
другая ветка — `BRANCH=…`). Возврат к Mock AI — `SKH_AI_PROVIDER=mock`. Подробно (архитектура, безопасность,
ошибки, обновление и откат) — [docs/CLAUDE_CODE_CLI_INTEGRATION.md](CLAUDE_CODE_CLI_INTEGRATION.md).

## Тесты и проверки

```bash
make check      # ruff + ruff format --check + mypy --strict + tsc + eslint + pytest + vitest
make e2e        # Playwright: офлайн-стек (нужен `make up`) + сам поднимает loopback-стек с тестовыми дублями
make e2e-gitlab # только сценарии на тестовых дублях (GitLab, создание документов, публикация)
make mock-e2e   # сквозной сценарий профиля integration_mock в Docker (нужен `make mock-up`)
make preflight  # офлайн-проверка конфигурации, соединений не выполняет
make readiness  # opt-in read-only проверка настроенных интеграций (обращается к ним, ничего не пишет)
make work-eval  # M6: детерминированные проверки задач, планирования, связей и AI-плана без AI и сети
```

Без `make`:

```bash
cd backend && ../.venv/bin/python -m pytest                    # все внешние системы — моки
cd backend && ../.venv/bin/ruff check app tests && ../.venv/bin/mypy app
cd frontend && npx vitest run && npx tsc --noEmit -p tsconfig.json && npx eslint .
cd frontend && npx playwright test                             # нужен запущенный стек; E2E_BASE_URL — адрес стека;
                                                               # E2E_SKIP_GITLAB_STACK=1 — без стека с дублями
```

- Во время pytest исходящие сокеты заблокированы: тест упадёт, если код попытается выйти в сеть.
- Браузер для Playwright ставится один раз: `cd frontend && npx playwright install chromium`.

**Состояние `main` (27.11.2026, `64e9c32`):**

| Проверка | Результат |
|---|---|
| `make check` | backend **1660 passed, 6 skipped** (live-тесты, только явно); frontend **761 passed**; ruff, format, mypy strict, tsc, eslint без замечаний |
| Playwright, обычный набор (desktop, mobile, тестовые дубли GitLab / MCP / Confluence) | **102 passed, 9 skipped** на `4fc9fc4`; после правок по ревью (`576bad0`) полный набор на перегруженной машине давал флаки в разных несвязанных тестах — упавшие при повторе проходили |
| Playwright на сценарном двойнике модели (`E2E_SCRIPTED_URL`) | **33 passed, 2 skipped** (пропуск — сценарии, которым нужен Confluence mock) |
| `make knowledge-eval` | 216 эталонных вопросов, **210** пройдено; шесть известных провалов разобраны в `reports/knowledge-eval/failures.md` |
| `make work-eval` | **17 / 17** |

Итоги по этапам — [reports/README.md](../reports/README.md).

Реальные GitLab, Confluence MCP и Confluence REST **не проверялись**.

## Конфигурация

Все параметры — переменные окружения. В [.env.example](../.env.example) только безопасные значения по умолчанию.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `INTEGRATION_PROFILE` | `offline` | Режим запуска: `offline` — без интеграций; `integration_mock` — только объявленные тестовые дубли; `live_read_only` — тестовые системы, только чтение; `live_write_staging` — тестовые системы с явно разрешённой записью ([правила](M4_M5_INTEGRATION_READINESS.md)) |
| `MOCK_SERVICE_HOSTS` | пусто | Только для `integration_mock`: хосты дублей (loopback, `*.example`, `*.test`, `*.invalid`, `*.localhost`, `<name>-mock`) |
| `AUTH_MODE` | `local_demo` | Только localhost; `sso` пока отклоняется при старте |
| `KNOWLEDGE_BACKEND` | `local` | `local` — workspace; `gitlab` — GitLab REST |
| `AI_PROVIDER` | `mock` | `mock` — дословные выдержки; `internal_api` — внутренний OpenAI-совместимый endpoint; `claude_cli` — личный тест; `disabled` — приложение без ИИ |
| `AI_TOOLS_ENABLED` | `true` | Инструменты системы для ассистента (каталог, поиск, граф, шаблоны) у провайдеров с моделью; лимиты — `AI_TOOLS_*` |
| `ATTACHMENTS_TTL_HOURS` | `24` | Сколько хранятся вложения диалога (только текст, не индексируются) |
| `CONFLUENCE_CONNECTOR` | `disabled` | `mock` — синтетические страницы для демо; `mcp` — утверждённый MCP-сервер (только чтение) |
| `GITLAB_PROPOSALS_ENABLED` | `false` | `true` — ветка + коммит + Draft MR (нужен `KNOWLEDGE_BACKEND=gitlab`; запрещено в `live_read_only`) |
| `DOCUMENT_TEMPLATES_DIR` | пусто | Каталог шаблонов; пусто — встроенные `backend/app/document_templates/` |
| `CONFLUENCE_REST_URL` | пусто | Confluence DC с context path; пусто — публикация выключена; задан — задания и dry-run (только чтение) |
| `CONFLUENCE_REST_TOKEN_FILE` | пусто | Файл с **отдельным** токеном публикации (совпадение с токеном MCP блокирует старт) |
| `CONFLUENCE_TARGET_SPACE`, `CONFLUENCE_PARENT_PAGE_ID` | пусто | Единственные пространство и родительская страница публикации |
| `CONFLUENCE_PUBLISH_ENABLED` | `false` | Запись в Confluence: только `integration_mock` или `live_write_staging` с `CONFLUENCE_PUBLISH_STAGING_ACK` и `CONFLUENCE_REST_CA_BUNDLE` |
| `PUBLICATION_STATE_PATH` | `./workspace/publications.sqlite3` | Задания и привязки документ → страница (нужна резервная копия) |

Полный перечень параметров, включая GitLab, MCP и AI, — в [.env.example](../.env.example) и
[docs/M4_M5_INTEGRATION_READINESS.md](M4_M5_INTEGRATION_READINESS.md).

## Подключение тестового контура

Подключать только после согласования; секреты — только из файлов вне репозитория.

```bash
cp deploy/integration/integration.env.example deploy/integration/integration.env   # git-ignored, без секретов
export SKH_SECRETS_DIR=~/.config/skh-secrets      # gitlab_token, confluence_mcp_token, confluence_rest_token, corporate-ca.pem
make preflight-integration    # офлайн-проверка конфигурации в контейнере, соединений не выполняет
make readiness                # только запросы чтения к настроенным системам
make integration-up           # запуск с исходящей сетью для backend — только после согласования
make test-live                # read-only смоук против тестового контура (явное включение SKH_LIVE_TESTS=1)
```

Порядок: сначала только чтение, затем dry-run публикации. Запись в пространство `[TEST]` — только по
отдельному разрешению ([docs/STAGING_TEST_RUNBOOK.md](STAGING_TEST_RUNBOOK.md)). Что нужно от
инфраструктуры — [docs/M4_M5_INTEGRATION_READINESS.md](M4_M5_INTEGRATION_READINESS.md).

## Структура репозитория

```text
backend/app/
  api/                 маршруты FastAPI
  adapters/            knowledge (local), gitlab, search (FTS5), ai, corporate (MCP), confluence_rest, publishers
  services/            knowledge, search, assistant (+ цикл инструментов), skills, work_skills, attachments, graph,
                       links, authoring, template_apply, proposals, ai_workflows, publications, integrations
  work/                модуль «Работа»: проекты, задачи, расписание, AI-план, предложения изменений, черновики задач
  domain/              модели, схема документа, безопасный Markdown, WikiLinks, шаблоны и реестр версий,
                       дерево документов, инструменты ассистента, Markdown → Confluence storage
  document_templates/  шаблоны документов (*.md с YAML-заголовком), прошлые версии — в history/
  assistant_instructions/  версионируемая политика ассистента
  authz.py             точки авторизации (право на каждом маршруте)
  config.py            настройки, профили запуска, fail-closed проверки
  preflight.py         офлайн-проверка конфигурации
  readiness.py         read-only проверка интеграций
  container.py         выбор адаптеров по конфигурации
backend/tests/         unit- и контрактные тесты; integration/ — replay MCP; live/ — opt-in смоук;
                       support/ — ТЕСТОВЫЕ ДУБЛИ GitLab, MCP, Confluence (в образ приложения не входят)
frontend/src/          React + TypeScript: страницы, компоненты (ui/ — базовые, shell/ — оболочка, docs/ — раздел
                       «Документы»), API-клиент; одна таблица стилей на токенах; тесты в __tests__
frontend/e2e/          Playwright-сценарии
fixtures/              83 синтетических документа, 216 эталонных случаев оценки, синтетический корпус Confluence
deploy/                тестовый контур, личный стенд Claude CLI (claude-test/), образ тестовых дублей
docs/                  документация (оглавление — docs/README.md); docs/ui-v2/ — спецификации интерфейса;
                       docs/images/ — скриншоты для README
reports/               сводка этапов (reports/README.md) и результаты make knowledge-eval / make work-eval
```

## API

Все пути начинаются с `/api`; схема — `GET /api/openapi.json`. Основные группы:
- **база знаний и поиск:** `/documents`, `/documents/tree`, `/documents/{id}/links`, `/search`, `/graph…`;
- **ассистент:** `/assistant/ask`, `/assistant/ask/stream` (NDJSON: этапы, вызовы инструментов, проверенный
  ответ), `/assistant/skills`, `/assistant/attachments`;
- **ИИ-предложения:** `/ai/proposals…` (принятие по пунктам);
- **предложения и черновики:** `/drafts…`, `…/apply-template`;
- **создание документов и шаблоны:** `/authoring…` (в т.ч. `/authoring/blank`), `/templates…`,
  `/documents/import…`;
- **публикация:** `/documents/{id}/publication…`, `/publications/jobs…`;
- **«Работа»:** `/projects…`, `/tasks…`, `/work-ai/proposals…` (AI-план), `/work-ai/change-proposals…` (изменения
  задач);
- **система:** `/integrations/status`, `/index…`, `/health`.

Полный контракт (актуальная версия v0.10) — [docs/API_CONTRACTS.md](API_CONTRACTS.md). Каждый маршрут, кроме `/health`,
объявляет право доступа. Изменяющие запросы требуют заголовок `X-SKH-Client` (защита от CSRF на localhost).

## Безопасность

Реализовано:
- доступ только с loopback, проверка `Host`;
- отказ запуска при небезопасной конфигурации;
- двойная санитизация Markdown и строгая CSP без сторонних источников;
- запрет path traversal и симлинков;
- секреты только из файлов, TLS не отключается;
- проверка каждой цитаты AI;
- журналы без тел запросов и токенов.

Подробнее — [docs/SECURITY.md](SECURITY.md).

**Не является продакшен-готовностью.** Нет SSO/RBAC, пользовательских прав GitLab и Confluence, согласованного
сетевого контура, аудита и резервного копирования. Полный перечень —
[docs/PRODUCTION_BLOCKERS.md](PRODUCTION_BLOCKERS.md).
