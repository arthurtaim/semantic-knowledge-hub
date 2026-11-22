# Semantic Knowledge Hub

Локальное MVP AI-native базы знаний для команды семантического слоя: навигация по документам, полнотекстовый поиск, ассистент с проверяемыми цитатами, создание документов по шаблонам (вручную или с демо-AI), предложения изменений с diff и ревью через GitLab MR и публикация утверждённых документов в Confluence Data Center с обязательным предпросмотром.

**Демо работает полностью офлайн на синтетических данных.** Не нужны доступы к GitLab, Confluence или AI API.

## Разделение систем
- **GitHub (этот репозиторий):** только исходный код, тесты, конфигурация и синтетические примеры (`fixtures/`).
- **GitLab (отдельный репозиторий):** рабочая база знаний команды — каноническая версия документов.
- **Confluence Data Center:** корпоративная документация через утверждённый read-only MCP; публикация утверждённых (смёрженных в GitLab) документов — отдельным REST-адаптером с отдельным токеном (реализовано, проверено только на тестовом дубле).
- **Claude Code** — инструмент разработки; **GigaCode** — целевая агентная среда (подключается через адаптер `AIProvider`, без переделки хранилища знаний).

Локальный workspace (`workspace/`) создаётся из `fixtures/knowledge` при первом запуске и игнорируется git.

---

## Быстрый старт (Docker)

Требуется Docker с Compose v2. Все команды в этом README выполняются **из корня репозитория**.

```bash
git clone <url-репозитория> semantic-knowledge-hub && cd semantic-knowledge-hub
docker compose up --build -d      # или: make up
```

Откройте <http://127.0.0.1:5173>. Порт публикуется только на `127.0.0.1` (переменная `BIND_ADDRESS`; при не-loopback значении бэкенд в режиме `local_demo` откажется стартовать). Бэкенд наружу не публикуется и работает в сети без выхода в интернет.

```bash
docker compose ps          # оба сервиса running, backend — healthy
docker compose logs -f     # журналы без тел запросов и query string
docker compose down        # остановить (данные workspace остаются в томе)
docker compose down -v     # остановить и удалить том: при следующем старте фикстуры засеются заново
```

## Запуск без Docker

Требуется Python 3.12+ и Node.js 20.19+ (или 22+). Все команды — из корня репозитория.

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

`python -m app` проверяет конфигурацию до старта: `AUTH_MODE=local_demo` с не-loopback адресом, `APP_ENV=production` или неразрешённым AI-хостом — приложение не запустится (fail closed).

## Демонстрационный сценарий (AC-01…AC-10)
1. Откройте главную: видна полоса «Демо-данные», разделы и статусы интеграций.
2. Найдите `ARIS` — синтетический документ `SEM-INT-ARIS-001` со статусом «Черновик» и источником «Локальный workspace».
3. Откройте его: справа «Паспорт документа» — статус, владелец, ревизия, `source_uri`, теги, связанные документы.
4. «Спросить»: `Где хранится каноническая база знаний команды?` — ответ из дословных выдержек с кликабельной цитатой (переход к разделу документа).
5. `Какие ограничения у интеграции ARIS?` — «Недостаточно данных»: черновик исключён из доказательной базы и показан отдельно. Включите «Учитывать черновики» — ассистент процитирует, что сведений нет, и не выдумает поток данных.
6. На документе «Предложить изменение» → правка → «Создать предложение»: diff построчно и «до/после», проверка метаданных.
7. «Отклонить» или «Отметить „Готово к ревью“» — исходный документ и его ревизия не меняются; этапы предложения показывают, что MR ещё нет, а отправка в GitLab в офлайн-режиме не настроена.
8. «Интеграции»: локальная база подключена; GitLab, Confluence, публикация и система задач — «Не подключено»; AI — «Демо (mock)»; у каждой интеграции видны цель («Не настроено» / «Локально» / «Тестовый дубль» / «Реальный сервер»), доступ и время проверки; блок «Синхронизация и поисковый индекс» с кнопкой «Синхронизировать сейчас».
9. «Создать документ» → «Вручную» или «С помощью AI» → тип документа (шаблон) → редактор с предпросмотром → «Сохранить черновик» (черновик хранится на backend и переживает перезапуск) → «Проверить» → «Отправить на ревью». В демо-режиме AI собирает структуру шаблона и дословные выдержки из утверждённых документов, остальное помечает «Требует уточнения». Процесс — [docs/DOCUMENT_CREATION_WORKFLOW.md](docs/DOCUMENT_CREATION_WORKFLOW.md).

### Полный цикл на тестовых дублях: профиль `integration_mock` (Docker)

Стек с **тестовыми дублями** GitLab REST, Confluence MCP и Confluence Data Center REST (`backend/tests/support/*_mock.py`, образ `deploy/mocks/Dockerfile`). Это не GitLab и не Confluence: дубли работают только во внутренней Docker-сети без портов на хосте; запись разрешена только потому, что все цели — объявленные дубли (`INTEGRATION_PROFILE=integration_mock`, `MOCK_SERVICE_HOSTS`).

```bash
make mock-up          # отдельный compose-проект skh-mock со своим томом; UI на http://127.0.0.1:5174
make mock-e2e         # сквозной сценарий внутри сети: черновик → MR → merge → синхронизация → dry-run → публикация → обновление → конфликт
make mock-readiness   # read-only probe интеграций изнутри backend-контейнера (цели помечены «тестовый дубль»)
make mock-logs        # журналы
make mock-down        # остановить и удалить том профиля
```

На <http://127.0.0.1:5174>: документы из «GitLab» (проект `skh-test/knowledge-base-MOCK`) → «Создать документ» или «Предложить изменение» → «Готово к ревью» → «Отправить в GitLab» (ветка `kb/update/…`, коммит `create`/`update`, Draft MR) → merge в дубле → «Проверить статус в GitLab» → «Принято (merge)», документ в базе → на странице документа блок «Публикация в Confluence»: предпросмотр (dry-run, только чтение) → «Опубликовать в Confluence». Ссылки на страницы Confluence помечены как тестовый дубль. Порты дублей наружу не публикуются, поэтому merge в дубле выполняется изнутри его контейнера (номер MR — на странице предложения):

```bash
docker compose -p skh-mock -f docker-compose.yml -f docker-compose.mock.yml exec gitlab-mock \
  python -c "import httpx; print(httpx.post('http://127.0.0.1:8929/__mock__/merge-requests/<iid>/merge').text)"
```

Без Docker (loopback-стек, как в Playwright):

```bash
cd backend && ../.venv/bin/python -m tests.support.gitlab_mock --port 8929          # терминал 1: дубль GitLab
cd backend && ../.venv/bin/python -m tests.support.mcp_mock --port 8930             # терминал 2: дубль Confluence MCP
cd backend && ../.venv/bin/python -m tests.support.confluence_mock --port 8931 \
  --public-url http://127.0.0.1:8931/confluence                                     # терминал 3: дубль Confluence DC REST
sh frontend/e2e/gitlab-stack.sh                                                     # терминал 4: backend (integration_mock) на :8011
cd frontend && SKH_BACKEND_URL=http://127.0.0.1:8011 FRONTEND_PORT=5175 npx vite    # терминал 5: UI на :5175
```

Merge в дубле GitLab: `curl -X POST http://127.0.0.1:8929/__mock__/merge-requests/<iid>/merge`. Правила процесса — [docs/GITLAB_KNOWLEDGE_WORKFLOW.md](docs/GITLAB_KNOWLEDGE_WORKFLOW.md), публикация — [docs/CONFLUENCE_SYNC_RUNBOOK.md](docs/CONFLUENCE_SYNC_RUNBOOK.md).

## Тесты и проверки

```bash
make check      # ruff + ruff format --check + mypy --strict + tsc + eslint + pytest + vitest
make e2e        # Playwright: E2E-01…12 и браузерные сценарии из E2E-13…36 — офлайн-стек (нужен `make up`) + сам поднимает loopback-стек с тестовыми дублями
make e2e-gitlab # только сценарии на тестовых дублях (@gitlab: жизненный цикл GitLab, создание, публикация)
make mock-e2e   # сквозной сценарий профиля integration_mock в Docker (нужен `make mock-up`)
make preflight  # офлайн-проверка конфигурации, соединений не выполняет
make readiness  # opt-in read-only probe настроенных интеграций (обращается к ним; ничего не пишет)
```

Без `make`:

```bash
cd backend && ../.venv/bin/python -m pytest                    # backend: unit + интеграционные (все внешние системы — моки)
cd backend && ../.venv/bin/ruff check app tests && ../.venv/bin/mypy app
cd frontend && npx vitest run && npx tsc --noEmit -p tsconfig.json && npx eslint .
cd frontend && npx playwright test                             # нужен запущенный стек; E2E_BASE_URL переопределяет адрес;
                                                               # E2E_SKIP_GITLAB_STACK=1 — без стека с GitLab-mock
```

Во время pytest исходящие сокеты заблокированы — тест упадёт, если код попытается выйти в сеть. Браузер для Playwright ставится один раз: `cd frontend && npx playwright install chromium`. Соответствие сценариев E2E-13…36 тестам — [docs/TEST_PLAN.md](docs/TEST_PLAN.md#m46--m4--m5-scenarios-e2e-13e2e-36).

**Последний прогон (2026-11-23, M4.6/M4/M5):**
- `make check`: backend 400 passed, 2 skipped (live-тесты, только по явному включению); frontend 88 passed; ruff, format, mypy strict, tsc и eslint без замечаний.
- `make preflight`: ошибок нет, исходящих подключений нет.
- `make up` с пустым томом: backend healthy; исходящая сеть из контейнера — `Network is unreachable`; чужой `Host` → 400; POST без `X-SKH-Client` → 403; черновик пережил `docker compose restart backend`.
- `make e2e`: 27 passed (desktop, mobile и стенд с тестовыми дублями GitLab/MCP/Confluence).
- `make mock-up` + `make mock-e2e`: сценарий из 8 шагов пройден; `make mock-readiness` показывает все цели как «тестовый дубль».

Реальные GitLab, Confluence MCP и Confluence REST **не проверялись**.

**Предыдущий прогон (2026-11-22, M4.5, macOS, Python 3.12, Node 26, Docker 29.4; до M4.6/M5):** `make check` — backend 319 passed + 2 skipped (opt-in live-тесты), frontend 46 passed, `ruff`/`ruff format --check`/`mypy --strict`/`tsc`/`eslint` без замечаний; `make preflight` — ошибок нет, исходящих подключений нет; `make up` с пустым томом — backend healthy, исходящая сеть из контейнера недоступна (`Network is unreachable`), чужой `Host` → 400, POST без `X-SKH-Client` → 403, тестовый дубль GitLab в образ не входит; `make e2e` — 16 passed (desktop, mobile и стек с GitLab-mock: E2E-01…E2E-12). Отказ запуска (код 2) проверен для `APP_HOST=0.0.0.0`, `AUTH_MODE=sso`, `http` к нелокальным GitLab/MCP/AI, нелокального `APP_PUBLIC_URL`, `CONFLUENCE_MCP_AUTH_MODEL=per_user`, `CONFLUENCE_PUBLISH_ENABLED=true`. GitLab и Confluence MCP проверены только на тестовом дубле и replay-сценариях — не на реальных системах. Соответствие тестов сценариям — в [docs/TEST_PLAN.md](docs/TEST_PLAN.md#m45-browser-scenarios-e2e-01e2e-12).

## Конфигурация

Все параметры — переменные окружения (см. [.env.example](.env.example), там только безопасные значения по умолчанию). Ключевые режимы:

| Переменная | По умолчанию | Значения |
|---|---|---|
| `AUTH_MODE` | `local_demo` | только localhost; `sso` пока отклоняется при старте |
| `KNOWLEDGE_BACKEND` | `local` | `local` — workspace; `gitlab` — GitLab REST (чтение, инкрементальная синхронизация, ревизии = SHA коммитов) |
| `AI_PROVIDER` | `mock` | `mock` — дословные выдержки; `internal_api` — внутренний OpenAI-совместимый endpoint; `disabled` |
| `INTEGRATION_PROFILE` | `offline` | `offline` — без интеграций; `integration_mock` — только объявленные тестовые дубли; `live_read_only` — тестовые системы, только чтение; `live_write_staging` — тестовые системы с явно разрешённой записью ([правила](docs/M4_M5_INTEGRATION_READINESS.md#0-режимы-запуска-integration_profile)) |
| `MOCK_SERVICE_HOSTS` | пусто | только для `integration_mock`: хосты дублей (loopback, `*.example`, `*.test`, `*.invalid`, `*.localhost`, `<name>-mock`) |
| `CONFLUENCE_CONNECTOR` | `disabled` | `mock` — синтетические страницы для демо; `mcp` — утверждённый MCP-сервер (только чтение) |
| `CONFLUENCE_MCP_STATUS_TTL_SECONDS` | `60` | сколько переиспользуются `tools/list` и статус MCP; `0` — проверять каждый раз |
| `GITLAB_PROPOSALS_ENABLED` | `false` | `true` — ветка `kb/update/…` + коммит `update`/`create` + Draft MR (требует `KNOWLEDGE_BACKEND=gitlab`; запрещено в `live_read_only`) |
| `DOCUMENT_TEMPLATES_DIR` | пусто | каталог шаблонов документов; пусто — встроенные `backend/app/document_templates/` ([шаблоны](docs/DOCUMENT_TEMPLATES.md)) |
| `GITLAB_KNOWLEDGE_PATH` | пусто | каталог документов в репозитории знаний (например `docs`) |
| `GITLAB_REFRESH_SECONDS` | `60` | как часто при обращении к данным проверять head ветки знаний |
| `CONFLUENCE_MCP_AUTH_MODEL` | `service_account` | общий токен: ACL пользователей не проверяются (только однопользовательский контур); `per_user` отклоняется до SSO |
| `APP_PUBLIC_URL` | пусто | адрес UI для ссылки на предложение в описании MR (в `local_demo` — только loopback) |
| `CONFLUENCE_REST_URL` | пусто | Confluence Data Center с context path; пусто — публикация выключена; задан — задания и dry-run (только чтение) |
| `CONFLUENCE_REST_TOKEN_FILE` | пусто | файл с **отдельным** токеном публикации (не токен MCP; совпадение блокирует старт) |
| `CONFLUENCE_TARGET_SPACE`, `CONFLUENCE_PARENT_PAGE_ID` | пусто | единственные пространство и родительская страница публикации (только из конфигурации) |
| `CONFLUENCE_PUBLISH_STATUSES` | `approved` | статусы документа, допускающие публикацию |
| `CONFLUENCE_PUBLISH_ENABLED` | `false` | запись в Confluence; `true` допускается только в `integration_mock` (цель — дубль) и `live_write_staging` (с `CONFLUENCE_PUBLISH_STAGING_ACK` = ключ пространства и `CONFLUENCE_REST_CA_BUNDLE`) |
| `PUBLICATION_STATE_PATH` | `./workspace/publications.sqlite3` | задания, привязки документ → страница, журнал публикации (нужна резервная копия) |

Подключение реальных систем (только после согласования, секреты — из хранилища секретов). Любая интеграция требует профиля, отличного от `offline` (обычно `INTEGRATION_PROFILE=live_read_only`):
- **Внутренняя модель:** `AI_PROVIDER=internal_api`, `AI_BASE_URL=https://…`, `AI_MODEL`, `AI_API_KEY`, `AI_ALLOWED_HOSTS=<хост из AI_BASE_URL>`.
- **GitLab:** `KNOWLEDGE_BACKEND=gitlab`, `GITLAB_URL`, `GITLAB_PROJECT_ID`, `GITLAB_KNOWLEDGE_PATH`, `GITLAB_TOKEN_FILE` (минимальные права на чтение; для MR — права на ветки/MR без доступа к защищённой ветке). `http` допускается только для loopback-адреса или объявленного тестового дубля в `integration_mock`; проверка TLS для реальных хостов не отключается.
- **Confluence MCP:** `CONFLUENCE_CONNECTOR=mcp`, `CONFLUENCE_MCP_URL`, `CONFLUENCE_MCP_AUTH_TOKEN`, `CONFLUENCE_ALLOWLISTED_SPACES`, `CONFLUENCE_LINK_HOSTS` и `CONFLUENCE_MCP_TOOL_MAP` — сопоставление с инструментами, которые реально объявил сервер (их список виден на странице «Интеграции», если сопоставление не задано или неверно).
- **Confluence DC REST (публикация):** `CONFLUENCE_REST_URL`, `CONFLUENCE_REST_TOKEN_FILE`, `CONFLUENCE_REST_CA_BUNDLE`, `CONFLUENCE_TARGET_SPACE`, `CONFLUENCE_PARENT_PAGE_ID`; запись — только `live_write_staging` после отдельного разрешения ([runbook](docs/CONFLUENCE_SYNC_RUNBOOK.md)).
- В Docker у бэкенда нет исходящей сети. Тестовый контур интеграций подключается отдельным override — см. раздел ниже.

«Подключено» в статусе выставляется только после реальной проверки (GitLab — проект и основная ветка, MCP — обнаружение инструментов, Confluence REST — пространство и родительская страница, AI — `/models`). Метка «Реальный сервер» не означает, что интеграция прошла live validation.

## Подготовка к подключению тестовых GitLab и Confluence (MCP и REST)

Режимы запуска, перечень параметров и доступов, чек-лист для инфраструктуры и то, что придётся адаптировать после live validation, — в [docs/M4_M5_INTEGRATION_READINESS.md](docs/M4_M5_INTEGRATION_READINESS.md); порядок проверки — [docs/STAGING_TEST_RUNBOOK.md](docs/STAGING_TEST_RUNBOOK.md). Кратко:

```bash
cp deploy/integration/integration.env.example deploy/integration/integration.env   # git-ignored, без секретов
export SKH_SECRETS_DIR=~/.config/skh-secrets      # вне репозитория: gitlab_token, confluence_mcp_token, confluence_rest_token, corporate-ca.pem
make preflight-integration    # офлайн-проверка конфигурации в контейнере, соединений не выполняет
make readiness                # read-only probe: только запросы чтения к настроенным системам
make integration-up           # запуск с исходящей сетью для backend — только после согласования
make test-live                # read-only смоук против тестового контура (явное включение SKH_LIVE_TESTS=1)
```

Секреты читаются только из файлов (`*_FILE`), корпоративный CA — через `*_CA_BUNDLE`. Запись в GitLab (`GITLAB_PROPOSALS_ENABLED`) и в Confluence (`CONFLUENCE_PUBLISH_ENABLED`) остаётся выключенной. `make preflight` проверяет текущую локальную конфигурацию.

> `docker-compose.integration.yml` передаёт в контейнер `INTEGRATION_PROFILE` (по умолчанию `live_read_only`) и переменные `CONFLUENCE_REST_*`, `CONFLUENCE_TARGET_SPACE`, `CONFLUENCE_PARENT_PAGE_ID`, `CONFLUENCE_PUBLISH_*`; проверка — `docker compose --env-file … -f docker-compose.yml -f docker-compose.integration.yml config`.

## Архитектура

```text
backend/app/
  adapters/knowledge   LocalKnowledgeRepository (+ общий построитель записей), контракт KnowledgeRepository
  adapters/gitlab      GitLabClient, GitLabKnowledgeRepository (read, merge evidence), GitLabMRPublisher (branch + update/create commit + MR)
  adapters/search      SqliteFtsSearchProvider (FTS5, производный индекс)
  adapters/ai          MockAIProvider, OpenAICompatibleAIProvider, DisabledAIProvider (answer, suggest_edit, draft_document)
  adapters/corporate   Disabled / Mock / ConfluenceMCPConnector (+ минимальный MCP-клиент), только чтение
  adapters/confluence_rest  ConfluenceDCClient (/rest/api Data Center), ConfluenceRESTPublisher (одно пространство + родитель)
  adapters/publishers  контракты ProposalPublisher, ConfluencePublisher и их выключенные реализации
  adapters/tasks       TaskSystemAdapter (не подключено)
  document_templates   пять шаблонов документов (*.md с YAML-заголовком)
  authz.py             точки авторизации: Action на каждом маршруте, политика local_demo (один оператор) / deny-all
  services             knowledge, search, assistant (проверка цитат), authoring (шаблоны, проверки, AI-черновик),
                       proposals (create/update, черновики, diff, состояния, аудит), publications (задания, dry-run,
                       публикация, сверка), integrations (метки target/access)
  domain               модели, схема документа, безопасный Markdown, шаблоны, Markdown → storage, эвристики
  config.py            настройки, профили запуска, fail-closed проверки; preflight.py (офлайн), readiness.py (read-only probe)
  container.py         выбор адаптеров по конфигурации
frontend/src           React + TypeScript (страницы, компоненты, API-клиент), тесты в __tests__, e2e в ../e2e
fixtures/knowledge     синтетические документы; fixtures/qa — 11 эталонных вопросов
fixtures/integration   записанные (синтетические) сценарии ответов MCP-сервера для replay-тестов
deploy/integration     шаблон конфигурации тестового контура (без секретов)
deploy/mocks           образ ТЕСТОВЫХ ДУБЛЕЙ для профиля integration_mock (в образ приложения не входит)
backend/tests          unit/контрактные тесты; integration/ — replay MCP; live/ — opt-in read-only смоук;
                       support/ — stateful ТЕСТОВЫЕ ДУБЛИ gitlab_mock.py, mcp_mock.py, confluence_mock.py и
                       сценарий mock_scenario.py (pytest, Playwright, Docker; в образ приложения не входят)
```

API (все пути с префиксом `/api`): `GET /health`, `GET /session`, `GET /documents` (`sort=`), `GET /documents/{id}`, `GET /knowledge/facets`, `GET /knowledge/issues`, `GET /search`, `POST /assistant/ask`, `GET /integrations/status`, `GET /index/status`, `POST /index/sync`, `POST /drafts`, `GET /drafts`, `GET /drafts/{id}`, `PUT /drafts/{id}`, `DELETE /drafts/{id}`, `POST /drafts/{id}/reject`, `POST /drafts/{id}/mark-ready`, `POST /drafts/{id}/submit`, `POST /drafts/{id}/refresh-status`, `POST /drafts/{id}/open-mr` (устаревший синоним submit), `POST /drafts/suggest`, `GET /corporate/pages/{id}`, `GET /authoring/templates`, `POST /authoring/check`, `POST /authoring/ai-draft`, `POST /authoring/drafts`, `GET /documents/{id}/publication`, `POST /documents/{id}/publication/prepare`, `GET /publications/jobs`, `GET /publications/jobs/{id}`, `POST /publications/jobs/{id}/dry-run`, `POST /publications/jobs/{id}/publish`, `POST /publications/jobs/{id}/reconcile`, `POST /publications/jobs/{id}/acknowledge-manual-edit`. Схема — `GET /api/openapi.json`; действующий контракт — [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md#implemented-contract-v03-m46--m4--m5) (v0.3). Каждый маршрут, кроме `/health`, объявляет право (`backend/app/authz.py`); изменяющие запросы требуют заголовок `X-SKH-Client` (защита от CSRF на localhost).

## Безопасность MVP
Реализовано: только loopback-доступ и проверка `Host`, отказ запуска при небезопасной конфигурации (включая профили запуска: запись только в объявленные тестовые дубли или в подтверждённый staging), санитизация Markdown на сервере и повторно в браузере, строгая CSP без сторонних источников (шрифты собираются локально), запрет path traversal и симлинков, проверка секретов/персональных данных в документах и предложениях, разграничение данных и инструкций для модели, проверка каждой цитаты по набору извлечённых фрагментов (и для AI-черновиков документов), журналы без тел запросов и токенов, аудит предложений и событий публикации без содержимого; публикация — только смёрженных в GitLab ревизий, после dry-run, явным действием, отдельным токеном, без перезаписи чужих и вручную изменённых страниц.

**Не является продакшен-готовностью.** Нет SSO/RBAC, пер-пользовательских прав GitLab/Confluence, ротации секретов и согласованного сетевого контура — полный перечень в [docs/PRODUCTION_BLOCKERS.md](docs/PRODUCTION_BLOCKERS.md), требования — в [docs/SSO_RBAC_REQUIREMENTS.md](docs/SSO_RBAC_REQUIREMENTS.md).

## Статус и дальнейшие шаги
- M0–M3 — готово и проверено (каркас, база знаний и поиск, ассистент с цитатами, предложения с diff).
- M4 — адаптеры GitLab (чтение, MR) и Confluence MCP сверены с официальной документацией GitLab REST v4 и спецификацией MCP 2025-06-18, покрыты контрактными тестами на фейковых серверах и replay-сценариями; конфигурация тестового контура подготовлена. С реальными системами соединений не было.
- M4.5 — GitLab как основное хранилище: инкрементальная синхронизация и индекс с ревизиями, полный жизненный цикл предложения (ветка → коммит → MR → merge → обновление базы) с обработкой конфликтов, таймаутов и неопределённых результатов, точки авторизации, улучшенный UI. Проверено на stateful GitLab-mock и replay-сценариях MCP; **с реальными системами не проверялось**.
- M4.6 — создание документов: пять шаблонов, генерация frontmatter, постоянные редактируемые черновики, проверка уникальности ID/пути, демо-AI без выдуманных фактов, операция `create` в GitLab (ветка → коммит → MR → merge → синхронизация). Проверено локально и на тестовом дубле GitLab; **с реальным GitLab не проверялось**.
- M4 readiness — профили запуска (`offline`, `integration_mock`, `live_read_only`, `live_write_staging`), stateful тестовые дубли GitLab, MCP и Confluence DC REST, Docker-профиль `integration_mock`, read-only `make readiness`, честные метки статусов. `live_read_only` и `live_write_staging` подготовлены, **но не запускались**.
- M5 — публикация в Confluence Data Center через REST: задания, обязательный dry-run (только чтение), явная публикация, привязка документ → страница с меткой владельца, версии, конфликты ручной правки, сверка после потерянного ответа, восстановление после перезапуска. Проверено только на тестовом дубле Confluence; **запись в реальный Confluence не включалась**.
- Далее по приоритету: 1) провести M4/M5 Live Validation по [docs/STAGING_TEST_RUNBOOK.md](docs/STAGING_TEST_RUNBOOK.md) — сначала только чтение и dry-run; 2) SSO/RBAC и пер-пользовательский доступ до любого многопользовательского запуска; 3) запись в `[TEST]`-пространство Confluence только по отдельному разрешению; 4) адаптер GigaCode после подтверждения доступного интерфейса (см. [docs/GIGACODE_MIGRATION.md](docs/GIGACODE_MIGRATION.md)).

## Документация
`CLAUDE.md`, `AGENTS.md` — правила для агентов; `docs/M4_M5_INTEGRATION_READINESS.md` — режимы запуска и подключение корпоративных систем; `docs/GITLAB_KNOWLEDGE_WORKFLOW.md` — структура базы знаний в GitLab, MR и синхронизация; `docs/DOCUMENT_CREATION_WORKFLOW.md` — создание документа от черновика до базы знаний; `docs/DOCUMENT_TEMPLATES.md` — шаблоны и frontmatter; `docs/AI_AUTHORING_CONTRACT.md` — контракт AI-черновиков; `docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md`, `docs/CONFLUENCE_MAPPING.md`, `docs/CONFLUENCE_SYNC_RUNBOOK.md` — публикация в Confluence; `docs/STAGING_TEST_RUNBOOK.md` — проверка на тестовом контуре; `docs/PRODUCTION_BLOCKERS.md`; `docs/SSO_RBAC_REQUIREMENTS.md`; `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DOCUMENT_SCHEMA.md`, `docs/API_CONTRACTS.md`, `docs/INTEGRATIONS.md`, `docs/UX.md`, `docs/SECURITY.md`, `docs/TEST_PLAN.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/DECISIONS.md`, `docs/GIGACODE_MIGRATION.md`.

> Установка Claude Code «на своём сервере» сама по себе не означает, что модель работает локально и банковские данные не уходят наружу. Пока сетевой контур AI не согласован, используйте только синтетические данные.
