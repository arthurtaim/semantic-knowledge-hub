# Semantic Knowledge Hub

База знаний для команды семантического слоя с AI-ассистентом: документы со структурой и связями, ответы с
проверяемыми цитатами, создание и правка документов через ревью, публикация утверждённого в Confluence.

**Демо работает полностью офлайн на синтетических данных.** Не нужны доступы к GitLab, Confluence или AI API.

> **Статус на 2026-11-24:** реализованы M0–M5, M5.6–M5.6.3, интерфейс UI v2, раздел «Документы» v2,
> ассистент с инструментами системы (M5.7) и «Пустой документ». Интеграции с GitLab и Confluence проверены
> только на локальных тестовых дублях. Приложение однопользовательское и **не готово к промышленному
> использованию** ([docs/PRODUCTION_BLOCKERS.md](docs/PRODUCTION_BLOCKERS.md)).

## Возможности

- **Документы** (`/documents`). Три вида: «Список» — дерево разделов и групп, список ветки и предпросмотр;
  «Обзор» — матрица «разделы × состояние» и «Что сделать»; «Таблица» — фильтры, сортировка, группировка,
  колонки. Поиск по всей базе — FTS5 с подсветкой и причинами совпадения, у каждого результата указан источник.
- **Ассистент** (главная и `/ask`). Диалог с цитатами: каждая цитата проверяется сервером, источники
  разделены на документы команды, корпоративные страницы и вложения. Сам выбирает инструменты системы
  (каталог, поиск, граф, шаблоны) для вопросов вроде «Сколько документов требуют внимания?» — числа берутся
  из реестра и показываются карточкой «По данным реестра SKH». Файлы (pdf, docx, xlsx, md, csv и др.),
  навыки через «/», документы через «@». Панель ассистента в документе (⌘J) и действия над выделенным текстом.
- **Создание документов.** «Пустой документ» без шаблона (технические метаданные формирует сервер) или по
  одному из 12 активных версионируемых шаблонов; шаблон можно применить позже — с предпросмотром diff.
  Свободный Markdown, WikiLinks `[[ID]]` с автодополнением и обратными ссылками, импорт Markdown.
- **Изменения через ревью.** AI и люди только предлагают: diff → ревью → (GitLab MR) → утверждение. Ничего не
  применяется без явного «Принять».
- **Карта знаний** (`/graph`). Типизированный граф с происхождением связей, группировка по типам, перетаскивание
  узлов, режимы «Вся база», «Вокруг узла», «Граф ответа».
- **Публикации** (`/publications`). Публикация утверждённых ревизий в Confluence Data Center только после
  предпросмотра и явным действием; список заданий со статусами.
- **Интеграции.** Для каждой видно, настроена ли она, на что направлена (локально / тестовый дубль / реальный
  сервер) и какой у неё доступ.

## Где что хранится

- **GitHub (этот репозиторий):** только код, тесты, конфигурация и синтетические примеры (`fixtures/`).
- **GitLab (отдельный репозиторий):** рабочая база знаний команды — каноническая версия документов.
- **Confluence Data Center:**
  - корпоративная документация — читается через утверждённый MCP, только чтение;
  - публикация утверждённых документов — отдельный REST-адаптер с отдельным токеном.
- **Claude Code** — инструмент разработки. **GigaCode** — целевая агентная среда; подключается через адаптер
  `AIProvider`, без переделки хранилища знаний.

Локальный каталог `workspace/` создаётся из `fixtures/knowledge` при первом запуске и игнорируется git.

---

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
ошибки, обновление и откат) — [docs/CLAUDE_CODE_CLI_INTEGRATION.md](docs/CLAUDE_CODE_CLI_INTEGRATION.md).

## Тесты и проверки

```bash
make check      # ruff + ruff format --check + mypy --strict + tsc + eslint + pytest + vitest
make e2e        # Playwright: офлайн-стек (нужен `make up`) + сам поднимает loopback-стек с тестовыми дублями
make e2e-gitlab # только сценарии на тестовых дублях (GitLab, создание документов, публикация)
make mock-e2e   # сквозной сценарий профиля integration_mock в Docker (нужен `make mock-up`)
make preflight  # офлайн-проверка конфигурации, соединений не выполняет
make readiness  # opt-in read-only проверка настроенных интеграций (обращается к ним, ничего не пишет)
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
- Соответствие сценариев E2E тестам — [docs/TEST_PLAN.md](docs/TEST_PLAN.md).

**Последний прогон (2026-11-24, ветка `feature/assistant-answer-quality`):**

| Проверка | Результат |
|---|---|
| `make check` | backend **836 passed, 6 skipped** (live-тесты, только явно); frontend **542 passed**; ruff, format, mypy strict, tsc, eslint без замечаний |
| Playwright, все проекты (стенды mock и disabled, тестовые дубли GitLab, MCP, Confluence) | **82 passed, 1 skipped** (desktop, mobile, gitlab-mock; пропущен сценарий, которому нужен Confluence) |
| E2E ассистента на сценарном двойнике модели | **15 passed** (`E2E_SCRIPTED_URL`, см. [docs/AI_NATIVE_TOOLS.md](docs/AI_NATIVE_TOOLS.md)) |
| `make knowledge-eval` | 216 случаев, 207 пройдено; Recall@1 0.9487, MRR 0.9647, утечек 0 |

Реальные GitLab, Confluence MCP и Confluence REST **не проверялись**.

## Конфигурация

Все параметры — переменные окружения. В [.env.example](.env.example) только безопасные значения по умолчанию.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `INTEGRATION_PROFILE` | `offline` | Режим запуска: `offline` — без интеграций; `integration_mock` — только объявленные тестовые дубли; `live_read_only` — тестовые системы, только чтение; `live_write_staging` — тестовые системы с явно разрешённой записью ([правила](docs/M4_M5_INTEGRATION_READINESS.md)) |
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

Полный перечень параметров, включая GitLab, MCP и AI, — в [.env.example](.env.example) и
[docs/M4_M5_INTEGRATION_READINESS.md](docs/M4_M5_INTEGRATION_READINESS.md).

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
отдельному разрешению ([docs/STAGING_TEST_RUNBOOK.md](docs/STAGING_TEST_RUNBOOK.md)). Что нужно от
инфраструктуры — [docs/IMPLEMENTATION_SUMMARY.md §12](docs/IMPLEMENTATION_SUMMARY.md#12-что-нужно-для-подключения-тестового-контура).

## Структура репозитория

```text
backend/app/
  api/                 маршруты FastAPI
  adapters/            knowledge (local), gitlab, search (FTS5), ai, corporate (MCP), confluence_rest, publishers
  services/            knowledge, search, assistant (+ цикл инструментов), skills, attachments, graph, links,
                       authoring, template_apply, proposals, ai_workflows, publications, integrations
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
docs/                  документация (см. ниже); docs/ui-v2/ — спецификации и макеты интерфейса
reports/               отчёты оценки поиска и M5.7
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
- **система:** `/integrations/status`, `/index…`, `/health`.

Полный контракт (v0.5) — [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md). Каждый маршрут, кроме `/health`,
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

Подробнее — [docs/SECURITY.md](docs/SECURITY.md).

**Не является продакшен-готовностью.** Нет SSO/RBAC, пользовательских прав GitLab и Confluence, согласованного
сетевого контура, аудита и резервного копирования. Полный перечень —
[docs/PRODUCTION_BLOCKERS.md](docs/PRODUCTION_BLOCKERS.md).

## Документация

| Документ | О чём |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md), [docs/UX.md](docs/UX.md) | Требования к продукту и интерфейсу |
| [docs/UI_REDESIGN.md](docs/UI_REDESIGN.md), [docs/ui-v2/](docs/ui-v2/) | Интерфейс: фазы, UI v2, «Документы» v2, «Пустой документ», отклонения от макетов |
| [docs/AI_NATIVE_TOOLS.md](docs/AI_NATIVE_TOOLS.md), [docs/AI_WORKFLOWS.md](docs/AI_WORKFLOWS.md), [docs/ASSISTANT_INSTRUCTIONS.md](docs/ASSISTANT_INSTRUCTIONS.md) | Ассистент: инструменты системы (M5.7), навыки и вложения, ИИ-предложения, политика |
| [docs/METADATA_AND_LINKS.md](docs/METADATA_AND_LINKS.md), [docs/TEMPLATE_HUB.md](docs/TEMPLATE_HUB.md), [docs/KNOWLEDGE_GRAPH.md](docs/KNOWLEDGE_GRAPH.md), [docs/SEARCH_SYNC_TEMPLATES.md](docs/SEARCH_SYNC_TEMPLATES.md), [docs/EXTERNAL_RAG.md](docs/EXTERNAL_RAG.md) | Метаданные и WikiLinks, шаблоны, граф, поиск и синхронизация, внешние источники |
| [docs/IMPLEMENTATION_SUMMARY.md](docs/IMPLEMENTATION_SUMMARY.md) | История вех M0–M5: как реализовано и проверено |
| [docs/CLAUDE_CODE_CLI_INTEGRATION.md](docs/CLAUDE_CODE_CLI_INTEGRATION.md) | Экспериментальный провайдер Claude Code CLI для личного теста |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md) | Архитектура и решения (ADR) |
| [docs/DOCUMENT_CREATION_WORKFLOW.md](docs/DOCUMENT_CREATION_WORKFLOW.md), [docs/DOCUMENT_TEMPLATES.md](docs/DOCUMENT_TEMPLATES.md), [docs/AI_AUTHORING_CONTRACT.md](docs/AI_AUTHORING_CONTRACT.md) | Создание документов, шаблоны, AI-черновики |
| [docs/GITLAB_KNOWLEDGE_WORKFLOW.md](docs/GITLAB_KNOWLEDGE_WORKFLOW.md) | База знаний в GitLab, MR и синхронизация |
| [docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md](docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md), [docs/CONFLUENCE_MAPPING.md](docs/CONFLUENCE_MAPPING.md), [docs/CONFLUENCE_SYNC_RUNBOOK.md](docs/CONFLUENCE_SYNC_RUNBOOK.md) | Публикация в Confluence |
| [docs/M4_M5_INTEGRATION_READINESS.md](docs/M4_M5_INTEGRATION_READINESS.md), [docs/STAGING_TEST_RUNBOOK.md](docs/STAGING_TEST_RUNBOOK.md), [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Режимы запуска и подключение тестового контура |
| [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md), [docs/DOCUMENT_SCHEMA.md](docs/DOCUMENT_SCHEMA.md) | API и формат документа |
| [docs/SECURITY.md](docs/SECURITY.md), [docs/SSO_RBAC_REQUIREMENTS.md](docs/SSO_RBAC_REQUIREMENTS.md), [docs/PRODUCTION_BLOCKERS.md](docs/PRODUCTION_BLOCKERS.md) | Безопасность, права, блокеры |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | План тестирования и матрица E2E |
| [docs/GIGACODE_MIGRATION.md](docs/GIGACODE_MIGRATION.md) | Переход на GigaCode |
| `CLAUDE.md`, `AGENTS.md` | Правила для агентов разработки |

> Установка Claude Code «на своём сервере» сама по себе не означает, что модель работает локально и
> банковские данные не уходят наружу. Пока сетевой контур AI не согласован, используйте только синтетические
> данные.
