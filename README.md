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
7. «Отклонить» или «Отметить „Готово к ревью“» — исходный документ и его ревизия не меняются; этапы предложения показывают, что MR ещё нет, а отправка в GitLab в офлайн-режиме не настроена.
8. «Интеграции»: локальная база подключена; GitLab, Confluence, публикация и система задач — «Не подключено»; AI — «Демо (mock)»; блок «Синхронизация и поисковый индекс» с кнопкой «Синхронизировать сейчас».

### Полный цикл с GitLab — на тестовом дубле (mock), без реального GitLab

```bash
make gitlab-mock                  # терминал 1: ТЕСТОВЫЙ ДУБЛЬ GitLab REST v4 на 127.0.0.1:8929 (не GitLab!)
sh frontend/e2e/gitlab-stack.sh   # терминал 2: backend в режиме KNOWLEDGE_BACKEND=gitlab на :8011
cd frontend && SKH_BACKEND_URL=http://127.0.0.1:8011 FRONTEND_PORT=5175 npx vite   # терминал 3: UI на :5175
```

На <http://127.0.0.1:5175>: документы из «GitLab» (проект `skh-test/knowledge-base-MOCK`) с SHA коммитов и ссылкой на ревизию → предложение → «Готово к ревью» → «Отправить в GitLab» (ветка `kb/update/…`, коммит, Draft MR) → merge через `curl -X POST http://127.0.0.1:8929/__mock__/merge-requests/1/merge` → «Проверить статус в GitLab» → «Принято (merge)», документ обновлён в базе. Confluence MCP в этом стенде намеренно указывает на пустой порт — виден статус «MCP недоступен». Правила процесса — [docs/GITLAB_KNOWLEDGE_WORKFLOW.md](docs/GITLAB_KNOWLEDGE_WORKFLOW.md).

## Тесты и проверки

```bash
make check      # ruff + ruff format --check + mypy --strict + tsc + eslint + pytest + vitest
make e2e        # Playwright: E2E-01…12 — офлайн-стек (нужен `make up`) + сам поднимает стек с GitLab-mock
make e2e-gitlab # только сценарии жизненного цикла с GitLab-mock (E2E-08…11)
```

Без `make`:

```bash
cd backend && ../.venv/bin/python -m pytest                    # backend: unit + интеграционные (все внешние системы — моки)
cd backend && ../.venv/bin/ruff check app tests && ../.venv/bin/mypy app
cd frontend && npx vitest run && npx tsc --noEmit -p tsconfig.json && npx eslint .
cd frontend && npx playwright test                             # нужен запущенный стек; E2E_BASE_URL переопределяет адрес;
                                                               # E2E_SKIP_GITLAB_STACK=1 — без стека с GitLab-mock
```

Во время pytest исходящие сокеты заблокированы — тест упадёт, если код попытается выйти в сеть. Браузер для Playwright ставится один раз: `cd frontend && npx playwright install chromium`.

**Последний прогон из корня репозитория (2026-11-22, M4.5, macOS, Python 3.12, Node 26, Docker 29.4):** `make check` — backend 319 passed + 2 skipped (opt-in live-тесты), frontend 46 passed, `ruff`/`ruff format --check`/`mypy --strict`/`tsc`/`eslint` без замечаний; `make preflight` — ошибок нет, исходящих подключений нет; `make up` с пустым томом — backend healthy, исходящая сеть из контейнера недоступна (`Network is unreachable`), чужой `Host` → 400, POST без `X-SKH-Client` → 403, тестовый дубль GitLab в образ не входит; `make e2e` — 16 passed (desktop, mobile и стек с GitLab-mock: E2E-01…E2E-12). Отказ запуска (код 2) проверен для `APP_HOST=0.0.0.0`, `AUTH_MODE=sso`, `http` к нелокальным GitLab/MCP/AI, нелокального `APP_PUBLIC_URL`, `CONFLUENCE_MCP_AUTH_MODEL=per_user`, `CONFLUENCE_PUBLISH_ENABLED=true`. GitLab и Confluence MCP проверены только на тестовом дубле и replay-сценариях — не на реальных системах. Соответствие тестов сценариям — в [docs/TEST_PLAN.md](docs/TEST_PLAN.md#m45-browser-scenarios-e2e-01e2e-12).

## Конфигурация

Все параметры — переменные окружения (см. [.env.example](.env.example), там только безопасные значения по умолчанию). Ключевые режимы:

| Переменная | По умолчанию | Значения |
|---|---|---|
| `AUTH_MODE` | `local_demo` | только localhost; `sso` пока отклоняется при старте |
| `KNOWLEDGE_BACKEND` | `local` | `local` — workspace; `gitlab` — GitLab REST (чтение, инкрементальная синхронизация, ревизии = SHA коммитов) |
| `AI_PROVIDER` | `mock` | `mock` — дословные выдержки; `internal_api` — внутренний OpenAI-совместимый endpoint; `disabled` |
| `CONFLUENCE_CONNECTOR` | `disabled` | `mock` — синтетические страницы для демо; `mcp` — утверждённый MCP-сервер |
| `GITLAB_PROPOSALS_ENABLED` | `false` | `true` — ветка `kb/update/…` + коммит + Draft MR (требует `KNOWLEDGE_BACKEND=gitlab`) |
| `GITLAB_KNOWLEDGE_PATH` | пусто | каталог документов в репозитории знаний (например `docs`) |
| `GITLAB_REFRESH_SECONDS` | `60` | как часто при обращении к данным проверять head ветки знаний |
| `CONFLUENCE_MCP_AUTH_MODEL` | `service_account` | общий токен: ACL пользователей не проверяются (только однопользовательский контур); `per_user` отклоняется до SSO |
| `APP_PUBLIC_URL` | пусто | адрес UI для ссылки на предложение в описании MR (в `local_demo` — только loopback) |
| `CONFLUENCE_PUBLISH_ENABLED` | `false` | публикация (M5) не реализована: `true` отклоняется при старте |

Подключение реальных систем (только после согласования, секреты — из хранилища секретов):
- **Внутренняя модель:** `AI_PROVIDER=internal_api`, `AI_BASE_URL=https://…`, `AI_MODEL`, `AI_API_KEY`, `AI_ALLOWED_HOSTS=<хост из AI_BASE_URL>`.
- **GitLab:** `KNOWLEDGE_BACKEND=gitlab`, `GITLAB_URL`, `GITLAB_PROJECT_ID`, `GITLAB_KNOWLEDGE_PATH`, `GITLAB_TOKEN_FILE` (минимальные права на чтение; для MR — права на ветки/MR без доступа к защищённой ветке). `http` допускается только для loopback-адреса (тестовый дубль); проверка TLS для реальных хостов не отключается.
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
  authz.py             точки авторизации: Action на каждом маршруте, политика local_demo (один оператор) / deny-all
  services             knowledge, search, assistant (проверка цитат), proposals (diff, состояния, аудит), integrations
  domain               модели, схема документа, безопасный Markdown, эвристики секретов/инъекций, анализ текста
  container.py         выбор адаптеров по конфигурации
frontend/src           React + TypeScript (страницы, компоненты, API-клиент), тесты в __tests__, e2e в ../e2e
fixtures/knowledge     синтетические документы; fixtures/qa — 11 эталонных вопросов
fixtures/integration   записанные (синтетические) сценарии ответов MCP-сервера для replay-тестов
deploy/integration     шаблон конфигурации тестового контура (без секретов)
backend/tests          unit/контрактные тесты; integration/ — replay MCP; live/ — opt-in read-only смоук;
                       support/gitlab_mock.py — stateful ТЕСТОВЫЙ ДУБЛЬ GitLab (pytest и E2E, в образ не входит)
```

API (все пути с префиксом `/api`): `GET /health`, `GET /session`, `GET /documents` (`sort=`), `GET /documents/{id}`, `GET /knowledge/facets`, `GET /knowledge/issues`, `GET /search`, `POST /assistant/ask`, `GET /integrations/status`, `GET /index/status`, `POST /index/sync`, `POST /drafts`, `GET /drafts`, `GET /drafts/{id}`, `POST /drafts/{id}/reject`, `POST /drafts/{id}/mark-ready`, `POST /drafts/{id}/submit`, `POST /drafts/{id}/refresh-status`, `POST /drafts/{id}/open-mr` (устаревший синоним submit), `POST /drafts/suggest`, `GET /corporate/pages/{id}`. Схема — `GET /api/openapi.json`; изменения описаны в [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md#implemented-contract-v02-m45). Каждый маршрут, кроме `/health`, объявляет право (`backend/app/authz.py`); изменяющие запросы требуют заголовок `X-SKH-Client`. Изменяющие запросы требуют заголовок `X-SKH-Client` (защита от CSRF на localhost).

## Безопасность MVP
Реализовано: только loopback-доступ и проверка `Host`, отказ запуска при небезопасной конфигурации, санитизация Markdown на сервере и повторно в браузере, строгая CSP без сторонних источников (шрифты собираются локально), запрет path traversal и симлинков, проверка секретов/персональных данных в документах и предложениях, разграничение данных и инструкций для модели, проверка каждой цитаты по набору извлечённых фрагментов, журналы без тел запросов и токенов, аудит предложений без содержимого.

**Не является продакшен-готовностью.** Нет SSO/RBAC, пер-пользовательских прав GitLab/Confluence, ротации секретов и согласованного сетевого контура — полный перечень в [docs/PRODUCTION_BLOCKERS.md](docs/PRODUCTION_BLOCKERS.md), требования — в [docs/SSO_RBAC_REQUIREMENTS.md](docs/SSO_RBAC_REQUIREMENTS.md).

## Статус и дальнейшие шаги
- M0–M3 — готово и проверено (каркас, база знаний и поиск, ассистент с цитатами, предложения с diff).
- M4 — адаптеры GitLab (чтение, MR) и Confluence MCP сверены с официальной документацией GitLab REST v4 и спецификацией MCP 2025-06-18, покрыты контрактными тестами на фейковых серверах и replay-сценариями; конфигурация тестового контура подготовлена. С реальными системами соединений не было.
- M4.5 — GitLab как основное хранилище: инкрементальная синхронизация и индекс с ревизиями, полный жизненный цикл предложения (ветка → коммит → MR → merge → обновление базы) с обработкой конфликтов, таймаутов и неопределённых результатов, точки авторизации, улучшенный UI. Проверено на stateful GitLab-mock и replay-сценариях MCP; **с реальными системами не проверялось**.
- Далее по приоритету: 1) M4 Live Validation по [docs/STAGING_TEST_RUNBOOK.md](docs/STAGING_TEST_RUNBOOK.md) — проверить GitLab/MCP-адаптеры на непродуктивном контуре и уточнить формат ответов MCP-инструментов; 2) SSO/RBAC и пер-пользовательский доступ до любого многопользовательского запуска; 3) M5 — публикация в Confluence с dry-run и защитой от конфликтов версий; 4) адаптер GigaCode после подтверждения доступного интерфейса (см. [docs/GIGACODE_MIGRATION.md](docs/GIGACODE_MIGRATION.md)).

## Документация
`CLAUDE.md`, `AGENTS.md` — правила для агентов; `docs/INTEGRATION_READINESS.md` — подключение корпоративных систем; `docs/GITLAB_KNOWLEDGE_WORKFLOW.md` — структура базы знаний в GitLab, MR и синхронизация; `docs/STAGING_TEST_RUNBOOK.md` — проверка на тестовом контуре; `docs/PRODUCTION_BLOCKERS.md`; `docs/SSO_RBAC_REQUIREMENTS.md`; `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DOCUMENT_SCHEMA.md`, `docs/API_CONTRACTS.md`, `docs/INTEGRATIONS.md`, `docs/UX.md`, `docs/SECURITY.md`, `docs/TEST_PLAN.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/DECISIONS.md`, `docs/GIGACODE_MIGRATION.md`.

> Установка Claude Code «на своём сервере» сама по себе не означает, что модель работает локально и банковские данные не уходят наружу. Пока сетевой контур AI не согласован, используйте только синтетические данные.
