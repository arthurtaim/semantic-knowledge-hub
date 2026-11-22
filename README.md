# Semantic Knowledge Hub

Локальное MVP AI-native базы знаний для команды семантического слоя: навигация по документам, полнотекстовый поиск, ассистент с проверяемыми цитатами и предложения изменений с diff и ревью.

**Демо работает полностью офлайн на синтетических данных.** Не нужны доступы к GitLab, Confluence или AI API.

## Разделение систем
- **GitHub (этот репозиторий):** только исходный код, тесты, конфигурация и синтетические примеры (`fixtures/`).
- **GitLab (отдельный репозиторий):** рабочая база знаний команды — каноническая версия документов.
- **Confluence Data Center:** корпоративная документация через утверждённый read-only MCP; позднее — публикация утверждённых страниц из GitLab.
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
7. «Отклонить» или «Отметить „Готово к ревью“» — исходный документ и его ревизия не меняются; MR в GitLab отключён.
8. «Интеграции»: локальная база подключена; GitLab, Confluence, публикация и система задач — «Не подключено»; AI — «Демо (mock)».

## Тесты и проверки

```bash
make check      # ruff + ruff format --check + mypy --strict + tsc + eslint + pytest + vitest
make e2e        # Playwright-смоук против запущенного стека (по умолчанию http://127.0.0.1:5173)
```

Без `make`:

```bash
cd backend && ../.venv/bin/python -m pytest                    # backend: unit + интеграционные (все внешние системы — моки)
cd backend && ../.venv/bin/ruff check app tests && ../.venv/bin/mypy app
cd frontend && npx vitest run && npx tsc --noEmit -p tsconfig.json && npx eslint .
cd frontend && npx playwright test                             # нужен запущенный стек; E2E_BASE_URL переопределяет адрес
```

Во время pytest исходящие сокеты заблокированы — тест упадёт, если код попытается выйти в сеть. Браузер для Playwright ставится один раз: `cd frontend && npx playwright install chromium`.

**Последний прогон из корня репозитория (2026-11-22, macOS, Python 3.12, Node 26, Docker 29.4):** `make setup` — ок; `make check` — backend 263 passed + 2 skipped (opt-in live-тесты), frontend 23 passed, `ruff`/`ruff format --check`/`mypy --strict`/`tsc`/`eslint` без замечаний; `make up` с пустым томом — backend healthy, исходящая сеть из контейнера недоступна, чужой `Host` → 400; `make e2e` — 5 passed (desktop + mobile); `make preflight` — ошибок нет; `make preflight-integration` на незаполненном шаблоне корректно перечисляет недостающие параметры. Отказ запуска при `APP_HOST=0.0.0.0` или публикации на не-loopback адрес проверен вручную (код выхода 2). Соответствие тестов сценариям приёмки — в [docs/TEST_PLAN.md](docs/TEST_PLAN.md#traceability-implemented-tests).

## Конфигурация

Все параметры — переменные окружения (см. [.env.example](.env.example), там только безопасные значения по умолчанию). Ключевые режимы:

| Переменная | По умолчанию | Значения |
|---|---|---|
| `AUTH_MODE` | `local_demo` | только localhost; `sso` пока отклоняется при старте |
| `KNOWLEDGE_BACKEND` | `local` | `local` — workspace; `gitlab` — read-only GitLab REST |
| `AI_PROVIDER` | `mock` | `mock` — дословные выдержки; `internal_api` — внутренний OpenAI-совместимый endpoint; `disabled` |
| `CONFLUENCE_CONNECTOR` | `disabled` | `mock` — синтетические страницы для демо; `mcp` — утверждённый MCP-сервер |
| `GITLAB_PROPOSALS_ENABLED` | `false` | `true` — ветка + коммит + MR (требует `KNOWLEDGE_BACKEND=gitlab`) |
| `CONFLUENCE_PUBLISH_ENABLED` | `false` | публикация (M5) не реализована: `true` отклоняется при старте |

Подключение реальных систем (только после согласования, секреты — из хранилища секретов):
- **Внутренняя модель:** `AI_PROVIDER=internal_api`, `AI_BASE_URL=https://…`, `AI_MODEL`, `AI_API_KEY`, `AI_ALLOWED_HOSTS=<хост из AI_BASE_URL>`.
- **GitLab:** `KNOWLEDGE_BACKEND=gitlab`, `GITLAB_URL`, `GITLAB_PROJECT_ID`, `GITLAB_TOKEN` (минимальные права на чтение; для MR — права на ветки/MR без доступа к защищённой ветке).
- **Confluence MCP:** `CONFLUENCE_CONNECTOR=mcp`, `CONFLUENCE_MCP_URL`, `CONFLUENCE_MCP_AUTH_TOKEN`, `CONFLUENCE_ALLOWLISTED_SPACES`, `CONFLUENCE_LINK_HOSTS` и `CONFLUENCE_MCP_TOOL_MAP` — сопоставление с инструментами, которые реально объявил сервер (их список виден на странице «Интеграции», если сопоставление не задано или неверно).
- В Docker у бэкенда нет исходящей сети. Тестовый контур интеграций подключается отдельным override — см. раздел ниже.

«Подключено» в статусе выставляется только после реальной проверки (GitLab — проект и основная ветка, MCP — обнаружение инструментов, AI — `/models`).

## Подготовка к подключению тестовых GitLab и Confluence MCP

Подробности, перечень параметров и доступов, чек-лист для инфраструктуры — в [docs/INTEGRATION_READINESS.md](docs/INTEGRATION_READINESS.md). Кратко:

```bash
cp deploy/integration/integration.env.example deploy/integration/integration.env   # git-ignored, без секретов
export SKH_SECRETS_DIR=~/.config/skh-secrets      # вне репозитория: gitlab_token, confluence_mcp_token, corporate-ca.pem
make preflight-integration    # офлайн-проверка конфигурации в контейнере, соединений не выполняет
make integration-up           # запуск с исходящей сетью для backend — только после согласования
make test-live                # read-only смоук против тестового контура (явное включение SKH_LIVE_TESTS=1)
```

Секреты читаются только из файлов (`*_FILE`), корпоративный CA — через `*_CA_BUNDLE`. Запись в GitLab (`GITLAB_PROPOSALS_ENABLED`) и в Confluence (`CONFLUENCE_PUBLISH_ENABLED`) остаётся выключенной. `make preflight` проверяет текущую локальную конфигурацию.

## Архитектура

```text
backend/app/
  adapters/knowledge   LocalKnowledgeRepository (+ общий построитель записей), контракт KnowledgeRepository
  adapters/gitlab      GitLabClient, GitLabKnowledgeRepository (read), GitLabMRPublisher (branch+commit+MR)
  adapters/search      SqliteFtsSearchProvider (FTS5, производный индекс)
  adapters/ai          MockAIProvider, OpenAICompatibleAIProvider, DisabledAIProvider
  adapters/corporate   Disabled / Mock / ConfluenceMCPConnector (+ минимальный MCP-клиент)
  adapters/publishers  ProposalPublisher, ConfluencePublisher (выключены)
  adapters/tasks       TaskSystemAdapter (не подключено)
  services             knowledge, search, assistant (проверка цитат), proposals (diff, состояния, аудит), integrations
  domain               модели, схема документа, безопасный Markdown, эвристики секретов/инъекций, анализ текста
  container.py         выбор адаптеров по конфигурации
frontend/src           React + TypeScript (страницы, компоненты, API-клиент), тесты в __tests__, e2e в ../e2e
fixtures/knowledge     синтетические документы; fixtures/qa — 11 эталонных вопросов
fixtures/integration   записанные (синтетические) сценарии ответов MCP-сервера для replay-тестов
deploy/integration     шаблон конфигурации тестового контура (без секретов)
backend/tests          unit/контрактные тесты; integration/ — replay MCP; live/ — opt-in read-only смоук
```

API (все пути с префиксом `/api`): `GET /health`, `GET /session`, `GET /documents`, `GET /documents/{id}`, `GET /knowledge/facets`, `GET /knowledge/issues`, `GET /search`, `POST /assistant/ask`, `GET /integrations/status`, `POST /drafts`, `GET /drafts`, `GET /drafts/{id}`, `POST /drafts/{id}/reject`, `POST /drafts/{id}/mark-ready`, `POST /drafts/{id}/open-mr`, `POST /drafts/suggest`, `GET /corporate/pages/{id}`. Схема — `GET /api/openapi.json`; изменения относительно исходного контракта описаны в [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md#implemented-contract-v01). Изменяющие запросы требуют заголовок `X-SKH-Client` (защита от CSRF на localhost).

## Безопасность MVP
Реализовано: только loopback-доступ и проверка `Host`, отказ запуска при небезопасной конфигурации, санитизация Markdown на сервере и повторно в браузере, строгая CSP без сторонних источников (шрифты собираются локально), запрет path traversal и симлинков, проверка секретов/персональных данных в документах и предложениях, разграничение данных и инструкций для модели, проверка каждой цитаты по набору извлечённых фрагментов, журналы без тел запросов и токенов, аудит предложений без содержимого.

**Не является продакшен-готовностью.** Нет SSO/RBAC, пер-пользовательских прав GitLab/Confluence, ротации секретов и согласованного сетевого контура — см. «Go-live gates» в [docs/SECURITY.md](docs/SECURITY.md).

## Статус и дальнейшие шаги
- M0–M3 — готово и проверено (каркас, база знаний и поиск, ассистент с цитатами, предложения с diff).
- M4 — адаптеры GitLab (чтение, MR) и Confluence MCP сверены с официальной документацией GitLab REST v4 и спецификацией MCP 2025-06-18, покрыты контрактными тестами на фейковых серверах и replay-сценариями; конфигурация тестового контура подготовлена. С реальными системами соединений не было.
- Далее по приоритету: 1) проверить GitLab/MCP-адаптеры на непродуктивном контуре и уточнить формат ответов MCP-инструментов; 2) SSO/RBAC и пер-пользовательский доступ до любого многопользовательского запуска; 3) M5 — публикация в Confluence с dry-run и защитой от конфликтов версий; 4) адаптер GigaCode после подтверждения доступного интерфейса (см. [docs/GIGACODE_MIGRATION.md](docs/GIGACODE_MIGRATION.md)).

## Документация
`CLAUDE.md`, `AGENTS.md` — правила для агентов; `docs/INTEGRATION_READINESS.md` — подключение корпоративных систем; `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DOCUMENT_SCHEMA.md`, `docs/API_CONTRACTS.md`, `docs/INTEGRATIONS.md`, `docs/UX.md`, `docs/SECURITY.md`, `docs/TEST_PLAN.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/DECISIONS.md`, `docs/GIGACODE_MIGRATION.md`.

> Установка Claude Code «на своём сервере» сама по себе не означает, что модель работает локально и банковские данные не уходят наружу. Пока сетевой контур AI не согласован, используйте только синтетические данные.
