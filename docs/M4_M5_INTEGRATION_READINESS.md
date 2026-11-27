# Готовность к подключению корпоративных систем (M4/M5, тестовый контур)

Документ для инфраструктурной команды, администраторов GitLab/Confluence, службы ИБ и команды
семантического слоя. Он описывает, что нужно, чтобы подключить Semantic Knowledge Hub к **тестовым**
GitLab, Confluence Data Center через MCP (чтение) и Confluence Data Center через REST (публикация), что уже
проверено и что придётся адаптировать после live validation.

Ранее документ назывался `docs/INTEGRATION_READINESS.md` (переименован в M4/M5, ADR-038).

**Текущий статус (2026-11-23).** Все адаптеры реализованы. Проверка — только локальная и только на
тестовых дублях. С реальными системами соединений не было.

| Компонент | Проверено локально | Проверено на тестовых дублях (mock) | Live validation |
|---|---|---|---|
| GitLab: чтение, синхронизация, ревизии | да (pytest, Playwright, Docker) | stateful GitLab-mock (`backend/tests/support/gitlab_mock.py`) | **не проводилась** |
| GitLab: ветка + коммит `update`/`create` + MR | да | stateful GitLab-mock, включая потерянные ответы и конфликты | **не проводилась** |
| GitLab: подтверждение merge по коммиту (`commits/:sha/merge_requests`) | да | GitLab-mock | **не проводилась** (squash/rebase — открытый вопрос, раздел 9) |
| Confluence MCP: discovery, поиск, чтение | да | stateful MCP-mock (`mcp_mock.py`) и replay-сценарии | **не проводилась** |
| Confluence DC REST: dry-run (только чтение) | да | stateful Confluence-mock (`confluence_mock.py`) | **не проводилась** |
| Confluence DC REST: создание/обновление страницы | да | Confluence-mock, только в профиле `integration_mock` | **не проводилась**, запись в реальный Confluence **не включалась** |

Запись в GitLab (ветка + MR) и в Confluence (страница) реализована, но в реальных системах выключена до
отдельного письменного разрешения.

## 0. Режимы запуска (`INTEGRATION_PROFILE`)

Профиль задаёт, **куда** backend может обращаться и **что** ему разрешено записывать. Проверка выполняется
до старта (`security_violations` в `backend/app/config.py`): при нарушении приложение, `python -m app.preflight`
и `python -m app.readiness` завершаются с ошибкой (fail closed).

| Профиль | Назначение | Правила старта |
|---|---|---|
| `offline` (по умолчанию) | демо на синтетических фикстурах, mock AI, без сети | Ни одна интеграция не используется: `KNOWLEDGE_BACKEND=gitlab`, `CONFLUENCE_CONNECTOR=mcp`, `AI_PROVIDER=internal_api` или непустой `CONFLUENCE_REST_URL` → отказ запуска. `CONFLUENCE_CONNECTOR=mock` (встроенные синтетические страницы) допустим. `MOCK_SERVICE_HOSTS` должен быть пуст |
| `integration_mock` | локальные stateful тестовые дубли GitLab, MCP и Confluence DC REST | Каждый настроенный адрес (`GITLAB_URL`, `CONFLUENCE_MCP_URL`, `AI_BASE_URL`, `CONFLUENCE_REST_URL`) должен указывать на тестовый дубль: loopback-адрес или хост из `MOCK_SERVICE_HOSTS`. Иначе — отказ. `http` допустим только для таких адресов и только с соответствующим `*_ALLOW_INSECURE_HTTP=true`. Запись (`GITLAB_PROPOSALS_ENABLED`, `CONFLUENCE_PUBLISH_ENABLED`) разрешена, потому что все цели — дубли |
| `live_read_only` | тестовые GitLab/MCP/Confluence, только чтение (подготовлено, **не запускалось**) | Все настроенные адреса — `https`. `GITLAB_PROPOSALS_ENABLED=true` и `CONFLUENCE_PUBLISH_ENABLED=true` → отказ. `CONFLUENCE_REST_URL` допустим: публикация работает только как dry-run (чтение) |
| `live_write_staging` | отдельный тестовый проект GitLab и `[TEST]`-пространство Confluence с явно разрешённой записью (подготовлено, **не запускалось**) | Все адреса — `https`. `CONFLUENCE_PUBLISH_ENABLED=true` требует `CONFLUENCE_PUBLISH_STAGING_ACK`, **дословно равный** `CONFLUENCE_TARGET_SPACE`, и корпоративный CA в `CONFLUENCE_REST_CA_BUNDLE` |

Общие правила для публикации (действуют при любом непустом `CONFLUENCE_REST_URL`):

- `CONFLUENCE_REST_URL` — абсолютный `https`-адрес без учётных данных, query и fragment;
  `http` — только для тестового дубля и с `CONFLUENCE_REST_ALLOW_INSECURE_HTTP=true`;
- `KNOWLEDGE_BACKEND=gitlab`: публикуются только подтверждённые merge-ревизии GitLab;
- `CONFLUENCE_TARGET_SPACE` — ключ пространства (`[A-Za-z0-9_~]{1,255}`), `CONFLUENCE_PARENT_PAGE_ID` —
  числовой ID (до 20 цифр);
- задан токен публикации `CONFLUENCE_REST_TOKEN(_FILE)`, и он **не совпадает** с токеном MCP;
- `CONFLUENCE_PUBLISH_STATUSES` — непустой список из `approved`, `in_review`, `draft`;
- `CONFLUENCE_PUBLISH_ENABLED=true` без `CONFLUENCE_REST_URL` или в профилях `offline`/`live_read_only` → отказ.

Итоговый режим публикатора (`build_confluence_publisher` в `backend/app/container.py`):

| Условие | Режим (`publisher.mode`) | Что доступно |
|---|---|---|
| `CONFLUENCE_REST_URL` пуст | `disabled` | ничего; API отвечает `503 publication_disabled` |
| URL задан, запись не разрешена | `dry_run_only` | задания публикации и dry-run (только GET) |
| URL задан, `CONFLUENCE_PUBLISH_ENABLED=true` и (`integration_mock` с целью-дублем или `live_write_staging`) | `write` | dry-run и явная публикация |

### `MOCK_SERVICE_HOSTS`

Список хостов, которые объявлены тестовыми дублями. Используется **только** с `INTEGRATION_PROFILE=integration_mock`
(в других профилях непустое значение — отказ запуска). Допустимы только (`valid_mock_host`):

- loopback (`localhost`, `127.0.0.0/8`, `::1`);
- зарезервированные домены `*.example`, `*.test`, `*.invalid`, `*.localhost` (RFC 2606 / RFC 6761);
- однословное имя Docker-сервиса, оканчивающееся на `-mock` (например `gitlab-mock`) — оно резолвится
  только внутри изолированной Docker-сети.

Не допускаются имена без суффикса `-mock` (например `gitlab` — может разрешиться через корпоративный DNS
search domain), корпоративные домены и частные IP. Так профиль `integration_mock` не может адресовать
реальный сервер.

### Метки статусов в UI и API

`GET /api/integrations/status` возвращает для каждой интеграции, кроме `state`, метки (вычисляются из
конфигурации и используемого адаптера, а не из наличия адреса):

| Поле | Значения | Смысл |
|---|---|---|
| `target` | `none` | не настроено |
| | `local` | встроено в приложение (локальный workspace, индекс, mock AI, встроенные синтетические страницы Confluence) |
| | `mock` | объявленный тестовый дубль (`integration_mock`) |
| | `real` | реальный сервер; **это не означает live validation** |
| `access` | `none` / `read` / `write` / `read_write` | что приложению разрешено делать с этой целью (`gitlab_proposals` — `write`, `confluence_publisher` в режиме `write` — `read_write`) |
| `checked_at` | время | когда выполнена проверка; есть и общий `checked_at` ответа |

`state=connected` выставляется только после фактической проверки: GitLab — проект и основная ветка, MCP —
`initialize` + `tools/list`, Confluence REST — чтение пространства и родительской страницы, AI — `/models`.

## 1. Как будет устроено подключение

```text
браузер ──127.0.0.1──> nginx (frontend) ──internal──> backend ──egress (только в тестовом контуре)──> GitLab REST v4
                                                                                                ├──> Confluence MCP (Streamable HTTP, чтение)
                                                                                                └──> Confluence DC REST /rest/api (публикация, отдельный токен)
секреты: файлы вне репозитория ──(read-only mount /run/skh-secrets)──> backend
```

- Конфигурация — `deploy/integration/integration.env` (копия шаблона `integration.env.example`, в git не попадает).
- Секреты — только файлами в каталоге вне репозитория (`SKH_SECRETS_DIR`), подключаются через `*_FILE`.
  Значения нигде не логируются и не выводятся.
- Корпоративный CA — `GITLAB_CA_BUNDLE`, `CONFLUENCE_MCP_CA_BUNDLE`, `CONFLUENCE_REST_CA_BUNDLE`, `AI_CA_BUNDLE` (PEM).
- Системные `HTTP(S)_PROXY` намеренно игнорируются (`trust_env=False`), редиректы не выполняются
  (`follow_redirects=False`); запросы идут только на явно настроенные хосты. Если нужен прокси — см. раздел 6.
- Токен MCP и токен публикации — **разные учётные данные**; совпадение блокирует запуск.

> **Известный пробел конфигурации (не исправлен в коде на момент написания).** `docker-compose.integration.yml`
> передаёт в контейнер backend только перечисленные в нём переменные; `--env-file` используется Compose
> лишь для подстановок. Переменные `INTEGRATION_PROFILE`, `CONFLUENCE_REST_*`, `CONFLUENCE_TARGET_SPACE`,
> `CONFLUENCE_PARENT_PAGE_ID`, `CONFLUENCE_PUBLISH_STATUSES`, `CONFLUENCE_PUBLISH_STAGING_ACK` в контейнер
> сейчас **не попадают**. Внутри контейнера действует профиль `offline`, и с `KNOWLEDGE_BACKEND=gitlab`
> `make preflight-integration` и `make integration-up` откажутся стартовать. До первого запуска тестового
> контура нужно добавить проброс этих переменных в `docker-compose.integration.yml` (задача для разработки;
> проверяется `docker compose ... config`).

## 2. Порядок первого подключения (только чтение)

1. Инфраструктура выполняет пункты раздела 6, команда получает значения из разделов 4 и 8.
2. `cp deploy/integration/integration.env.example deploy/integration/integration.env`, заполнить; секреты
   положить в `SKH_SECRETS_DIR`. Профиль — `INTEGRATION_PROFILE=live_read_only`.
3. `export SKH_SECRETS_DIR=…; make preflight-integration` — офлайн-проверка в контейнере: ошибки конфигурации
   и список хостов, к которым backend будет обращаться. Соединений не выполняет.
4. Узнать имена инструментов MCP: администратор MCP предоставляет вывод `tools/list` (или страница
   «Интеграции» после запуска покажет обнаруженные инструменты). Заполнить `CONFLUENCE_MCP_TOOL_MAP`,
   при необходимости `CONFLUENCE_MCP_RESULT_MAP`.
5. `make readiness` (или `python -m app.readiness` внутри контейнера) — **opt-in read-only probe**: обращается
   к настроенным системам только запросами чтения (GitLab — проект и ветка, MCP — `initialize` + `tools/list`,
   Confluence REST — пространство и родительская страница, AI — `/models`). Ничего не записывает. Код
   выхода: 0 — все настроенные интеграции ответили, 1 — есть ошибки, 2 — небезопасная конфигурация.
   Ответ реального сервера — проверка доступности, **а не live validation**.
6. `make integration-up` — запуск; на странице «Интеграции» статусы должны стать «Подключено» с `target=real`
   (только после реальной проверки).
7. `make test-live` — read-only смоук: чтение документов GitLab и поиск в разрешённых пространствах.
   Ничего не записывает.
8. Обезличенные ответы MCP тестового пространства (синтетические страницы `[TEST]`) добавить как сценарий
   в `fixtures/integration/confluence_mcp/` — см. README там.
9. Только после этого и отдельного решения — этап записи: `GITLAB_PROPOSALS_ENABLED=true` на тестовом
   проекте; затем, отдельно, публикация в `[TEST]`-пространство (`docs/STAGING_TEST_RUNBOOK.md`, раздел 7).

## 3. Соответствие официальным контрактам

### GitLab REST API v4
Проверено по документации docs.gitlab.com (repositories, repository_files, branches, commits,
merge_requests, rest, authentication) 2026-11-22; поведение закреплено тестами `backend/tests/test_gitlab.py`,
`test_gitlab_lifecycle.py`, `test_gitlab_create.py` на тестовом дубле GitLab.

| Операция | Запрос | Соответствие и обработка |
|---|---|---|
| Проверка доступа | `GET /projects/:id` + `GET /projects/:id/repository/branches/:branch` с `PRIVATE-TOKEN` | Проект может отвечать без авторизации, поэтому дополнительно проверяется ветка — она требует прав на чтение репозитория |
| Список документов | `GET /projects/:id/repository/tree?ref&recursive=true&path&per_page=100&pagination=keyset` | Keyset-пагинация, как рекомендует GitLab; из заголовка `Link` берётся только `page_token`, сам URL не используется. Запасной вариант — offset (`X-Next-Page`) |
| Чтение файла | `GET /projects/:id/repository/files/:file_path?ref` (путь кодируется, `/` → `%2F`) | Поля `size`, `encoding=base64`, `content`, `last_commit_id`. Ревизия документа = `last_commit_id` (SHA последнего коммита, изменившего файл) |
| Ветка предложения | `POST /projects/:id/repository/branches?branch&ref` | Ответ «ветка уже существует» не документирован → при ошибке существование проверяется явным `GET` ветки |
| Коммит изменения | `POST /projects/:id/repository/commits` с `actions[{action:update, file_path, content, last_commit_id}]` | `last_commit_id` — проверка, что файл не изменился. Отказ GitLab (400) не документирован детально → решение по фактической ревизии файла: конфликт или ошибка |
| Коммит нового документа | `POST /projects/:id/repository/commits` с `actions[{action:create, file_path, content}]` (без `last_commit_id`) | GitLab отклоняет `create` существующего файла (400) → решение по факту: файл есть — конфликт `document_exists`, ничего не перезаписано |
| Поиск MR | `GET /projects/:id/merge_requests?source_branch&state=all` | `state=all`: закрытый ревьюером MR не пересоздаётся |
| Создание MR | `POST /projects/:id/merge_requests` (`source_branch`, `target_branch`, `title` с префиксом `Draft:`, `description`, `remove_source_branch`) | Ответ на дубликат не документирован → при любой ошибке ищется существующий MR. Префикс `Draft:` делает MR черновиком |
| Подтверждение merge для публикации | `GET /projects/:id/repository/commits/:sha/merge_requests` | Публикуется только ревизия, для которой GitLab вернул MR со `state=merged` и `target_branch` = ветка знаний. Поведение для squash/rebase merge — раздел 9 |
| Ограничение частоты | `429` + `Retry-After` | Учитывается (не более 5 с). Повторяются только GET; POST не повторяется, чтобы не продублировать коммит |

### MCP (спецификация 2025-06-18, Streamable HTTP)
Проверено по modelcontextprotocol.io (transports, lifecycle, tools); тесты `backend/tests/test_confluence_mcp.py`,
`test_mcp_mock_contract.py` (stateful MCP-mock) и `tests/integration/test_confluence_mcp_replay.py`.

- Каждое сообщение — `POST` на один endpoint с `Accept: application/json, text/event-stream`; поддерживаются оба формата ответа.
- `initialize` → `notifications/initialized` (ожидается 202) → запрос → `DELETE` с `Mcp-Session-Id` для
  завершения сессии; `MCP-Protocol-Version: 2025-06-18` в последующих запросах.
- `tools/list` с переходом по `nextCursor`; имена инструментов и аргументы проверяются по `inputSchema` и никогда не угадываются.
- `tools/call`: `isError: true` — ошибка выполнения (для чтения страницы трактуется как «не найдено/нет доступа»);
  JSON-RPC `error` — ошибка протокола.
- Результат: `structuredContent` или JSON в текстовом блоке; поля страницы ищутся по `CONFLUENCE_MCP_RESULT_MAP`.
- Ожидаемое поведение на stateful MCP-mock (то же нужно подтвердить на реальном сервере): пагинация
  `tools/list`, отбрасывание страниц из неразрешённых пространств даже если сервер их вернул, новая версия
  страницы видна при повторном чтении, явные ошибки `mcp_tool_missing`, `mcp_tool_schema_mismatch`,
  `mcp_auth_failed`, `mcp_http_error`, `mcp_invalid_response`, `mcp_rpc_error`, `mcp_timeout`; ошибка
  инструмента при чтении — «не найдено», а не фиктивная страница.
- MCP **никогда** не используется для записи в Confluence (ADR-032).

### Confluence Data Center REST API (`/rest/api`, не Cloud v2)
Адаптер: `backend/app/adapters/confluence_rest/client.py`. Сверено с официальной документацией Confluence
Server/Data Center REST (`docs/README.md`); закреплено тестами `test_publications.py` на stateful
Confluence-mock. **На реальном Confluence DC не проверялось.**

| Операция | Запрос | Обработка |
|---|---|---|
| Пространство | `GET /rest/api/space/:key` | 404 → «не найдено» (`space_not_found` в dry-run) |
| Страница | `GET /rest/api/content/:id?expand=body.storage,version,space,ancestors` | 404 → нет страницы |
| Поиск по заголовку | `GET /rest/api/content?spaceKey&title&type=page&expand=…&limit=5` | только в целевом пространстве; результат без метки владельца — чужая страница |
| Метка владельца | `GET /rest/api/content/:id/property/skh-managed-document` | 404 → метки нет |
| Создание | `POST /rest/api/content` (`type=page`, `space.key`, `ancestors=[{id: parent}]`, `body.storage`, `metadata.properties`) | метка передаётся в `metadata.properties`; если после создания её нет — отдельный `POST /rest/api/content/:id/property` |
| Обновление | `PUT /rest/api/content/:id` (`version.number` = текущая + 1, `ancestors=[{id: parent}]`, `body.storage`) | 409 → конфликт версий, ничего не перезаписано |
| Аутентификация | `Authorization: Bearer <PAT>`, `X-Atlassian-Token: no-check` | 401 → `confluence_auth_failed`, 403 → `confluence_forbidden` |
| Повторы | GET: до 2 повторов при 429/502/503/504 и таймауте (пауза до 5 с) | POST/PUT **не повторяются**; таймаут или 5xx после записи → результат неизвестен, сначала проверка состояния страницы |

Что **не** проверено: реальные ответы MCP-сервера банка (имена инструментов, формат результатов, передача
пользователя); поведение реального GitLab на ошибках, отмеченных выше как недокументированные; поведение
реального Confluence DC (нормализация storage, `metadata.properties`, права, лимиты) — раздел 9.

## 4. Параметры

| Параметр | Назначение | Формат / пример | Кто предоставляет | Секрет |
|---|---|---|---|---|
| `INTEGRATION_PROFILE` | Режим запуска (раздел 0) | `live_read_only` для первого подключения | Команда / решение ИБ | нет |
| `MOCK_SERVICE_HOSTS` | Хосты тестовых дублей (только `integration_mock`) | пусто на тестовом контуре | — | нет |
| `GITLAB_URL` | Адрес тестового GitLab | `https://gitlab.<corp>` | Администраторы GitLab | нет |
| `GITLAB_PROJECT_ID` | Тестовый проект базы знаний | `1234` или `group%2Fknowledge-test` | Администраторы GitLab | нет |
| `GITLAB_DEFAULT_BRANCH` | Защищённая основная ветка | `main` | Команда | нет |
| `GITLAB_KNOWLEDGE_PATH` | Каталог документов в репозитории | `docs` или пусто | Команда | нет |
| `GITLAB_TOKEN_FILE` | Файл с токеном (см. раздел 5) | `/run/skh-secrets/gitlab_token` | Администраторы GitLab | **да** |
| `GITLAB_CA_BUNDLE` | Корпоративный CA для TLS | `/run/skh-secrets/corporate-ca.pem` | Инфраструктура | нет |
| `CONFLUENCE_MCP_URL` | Endpoint утверждённого MCP-сервера | `https://mcp.<corp>/mcp` | Владельцы MCP-сервиса | нет |
| `CONFLUENCE_MCP_AUTH_TOKEN_FILE` | Файл с токеном MCP (Bearer) | `/run/skh-secrets/confluence_mcp_token` | Владельцы MCP-сервиса | **да** |
| `CONFLUENCE_MCP_CA_BUNDLE` | CA для TLS к MCP | PEM | Инфраструктура | нет |
| `CONFLUENCE_ALLOWLISTED_SPACES` | Разрешённые для чтения пространства | `SKHTEST` | Администраторы Confluence | нет |
| `CONFLUENCE_MCP_TOOL_MAP` | Сопоставление поиска/чтения с инструментами | JSON (см. шаблон) | По выводу `tools/list` | нет |
| `CONFLUENCE_MCP_RESULT_MAP` | Где в ответе id/space/title/url | JSON, опционально | По примеру ответа | нет |
| `CONFLUENCE_LINK_HOSTS` | Хосты, на которые можно ссылаться | `confluence.<corp>` | Администраторы Confluence | нет |
| `CONFLUENCE_WEB_BASE_URL` | База для относительных ссылок | `https://confluence.<corp>` | Администраторы Confluence | нет |
| `CONFLUENCE_REST_URL` | Базовый URL Confluence DC **с context path**; пусто — публикация выключена | `https://confluence.<corp>/confluence` | Администраторы Confluence | нет |
| `CONFLUENCE_REST_TOKEN_FILE` | Файл с отдельным токеном публикации (PAT); не токен MCP | `/run/skh-secrets/confluence_rest_token` | Администраторы Confluence | **да** |
| `CONFLUENCE_REST_CA_BUNDLE` | CA для TLS к Confluence REST; обязателен для записи в `live_write_staging` | PEM | Инфраструктура | нет |
| `CONFLUENCE_REST_TIMEOUT_SECONDS` | Таймаут запросов к Confluence REST | `15` (0 < x ≤ 120) | Команда | нет |
| `CONFLUENCE_REST_ALLOW_INSECURE_HTTP` | `http` к Confluence REST — только для тестового дубля | `false` | — | нет |
| `CONFLUENCE_TARGET_SPACE` | Единственное пространство публикации | `SKHTEST` | Администраторы Confluence | нет |
| `CONFLUENCE_PARENT_PAGE_ID` | Родительская страница публикуемых страниц (числовой ID) | `123456` | Администраторы Confluence | нет |
| `CONFLUENCE_PUBLISH_STATUSES` | Статусы документа, допускающие публикацию | `approved` (по умолчанию) | Владелец продукта | нет |
| `CONFLUENCE_PUBLISH_ENABLED` | Запись в Confluence | `false`; `true` — только `integration_mock`/`live_write_staging` | Решение владельца продукта и ИБ | нет |
| `CONFLUENCE_PUBLISH_STAGING_ACK` | Подтверждение записи в `live_write_staging`: повторяет ключ `CONFLUENCE_TARGET_SPACE` | пусто, пока запись не разрешена | Ответственный за staging-тест | нет |
| `PUBLICATION_STATE_PATH` | SQLite заданий и привязок публикации | `/data/workspace/publications.sqlite3` (в образе) | Оператор стенда | нет (но бэкап обязателен) |
| `DOCUMENT_TEMPLATES_DIR` | Каталог шаблонов документов; пусто — встроенные | пусто | Команда | нет |
| `GITLAB_PROPOSALS_ENABLED` | Запись: ветка + коммит + MR | `false` на этапе чтения | Решение владельца продукта | нет |
| `AI_*` | Внутренняя модель (отдельное согласование) | `AI_PROVIDER=mock` по умолчанию | Владельцы AI-платформы | ключ — да |
| `SKH_SECRETS_DIR` | Каталог секретов на хосте (вне репозитория) | `~/.config/skh-secrets` | Оператор стенда | — |
| `GITLAB_REFRESH_SECONDS` | Как часто проверять head ветки при обращении к данным | `60` | Команда | нет |
| `CONFLUENCE_MCP_AUTH_MODEL` | Модель доступа MCP | `service_account` (единственная разрешённая сейчас) | Владельцы MCP-сервиса | нет |
| `CONFLUENCE_MCP_STATUS_TTL_SECONDS` | Сколько секунд переиспользуются результат `tools/list` и статус MCP (0 — проверять каждый раз) | `60` (0…3600) | Команда | нет |
| `APP_PUBLIC_URL` | Ссылка на предложение в описании MR | `http://127.0.0.1:5173` (только loopback в `local_demo`) | Оператор стенда | нет |

Имена из заданий M4.5 и действующий контракт (новые синонимы не вводились, чтобы не дублировать конфигурацию — ADR-018):

| В задании | В приложении |
|---|---|
| `KNOWLEDGE_PROVIDER=local\|gitlab` | `KNOWLEDGE_BACKEND=local\|gitlab` |
| `GITLAB_BASE_URL` | `GITLAB_URL` |
| `GITLAB_DOCS_PATH` | `GITLAB_KNOWLEDGE_PATH` |
| `GITLAB_PROJECT_ID`, `GITLAB_DEFAULT_BRANCH`, `GITLAB_TOKEN_FILE`, `GITLAB_CA_BUNDLE` | без изменений |

## 5. Доступы и права

**GitLab (тестовый проект):**
- Этап 1 (чтение): токен проекта/группы или сервисной учётной записи со scope `read_api` (достаточно для
  repository tree/files и для `commits/:sha/merge_requests`); роль в проекте не ниже Reporter. Персональные
  токены сотрудников не использовать.
- Этап 2 (предложения): scope `api`, роль Developer; основная ветка защищена (merge только Maintainer/по
  правилам approval), push в неё для токена запрещён. Приложение коммитит только в ветки
  `kb/update/<ID>-<suffix>` и открывает Draft MR (`docs/GITLAB_KNOWLEDGE_WORKFLOW.md`).
- Срок жизни токена и процедура ротации — по политике банка; токен кладётся файлом, перезапуск подхватывает новый.

**Confluence Data Center через MCP (чтение):**
- Отдельное тестовое пространство (например, `SKHTEST`) только с синтетическими страницами `[TEST]`.
- MCP-сервер в режиме только чтения; доступ сервисной учётной записи ограничен тестовым пространством.
- Нужно подтвердить модель авторизации: сервисный токен (тогда приложение остаётся однопользовательским —
  так требует docs/INTEGRATIONS.md) или передача пользователя (per-user ACL — обязательна для
  многопользовательского режима, ещё не реализована).

**Confluence Data Center через REST (публикация):**
- Отдельная техническая учётная запись публикации и её PAT; **не** токен MCP и не персональный токен.
- Минимальные права: просмотр целевого пространства; создание страниц под родительской страницей;
  редактирование страниц, созданных этой учётной записью; создание и чтение content property. Права на
  удаление страниц и администрирование пространства не нужны и не должны выдаваться.
- Доступ ограничен **одним** тестовым пространством `[TEST]`. Общекорпоративные пространства и реальная
  документация для write-тестов запрещены.
- Согласованный ключ ownership-метки: content property `skh-managed-document` (`docs/CONFLUENCE_MAPPING.md`).
- Версия Confluence DC должна поддерживать Personal Access Tokens (Bearer); иначе нужна доработка адаптера.

## 6. Что нужно от инфраструктурной команды

- [ ] Хост/ВМ для тестового стенда с Docker Compose v2 (или согласованная альтернатива), без публикации наружу: UI слушает только `127.0.0.1`.
- [ ] Сетевой доступ **только** с этого хоста: к тестовому GitLab (443/TCP), к MCP-серверу Confluence (порт сервиса) и — для этапа публикации — к Confluence DC (443/TCP). Больше ничего; интернет не нужен.
- [ ] Если прямого маршрута нет — параметры корпоративного прокси (приложение сейчас прокси не использует; потребуется явная настройка, ~0,5 дня работы).
- [ ] PEM-файл корпоративного корневого/промежуточного CA, которым подписаны сертификаты GitLab, MCP и Confluence.
- [ ] DNS-имена тестовых GitLab, MCP и Confluence, резолвящиеся с хоста стенда.
- [ ] Способ доставки секретов на хост (vault agent, файл с правами 600/0640 для uid 10001 или Docker/K8s secrets) и процедура ротации — отдельно для токенов GitLab, MCP и публикации.
- [ ] Тестовый проект GitLab + токен (раздел 5), защищённая ветка `main`, синтетические документы в формате `docs/DOCUMENT_SCHEMA.md`.
- [ ] Endpoint MCP-сервера Confluence DC, его токен, вывод `tools/list` и пример ответа поиска/чтения на тестовом пространстве.
- [ ] Тестовое пространство Confluence с синтетическими страницами, родительская страница для публикации, учётная запись публикации с доступом только к нему.
- [ ] Резервное копирование тома с `publications.sqlite3` (привязки документ → страница) и `app_state.sqlite3` (предложения) — `docs/CONFLUENCE_SYNC_RUNBOOK.md`, раздел 8.
- [ ] Требования к журналам: куда собирать stdout контейнеров, срок хранения (журналы не содержат тел запросов и токенов); хранение журнала событий публикации.
- [ ] Подтверждение, что на тестовом контуре нет реальных банковских данных, и согласование выхода в сеть со службой ИБ.

## 7. Открытые вопросы
- Модель авторизации MCP (сервисный токен или передача пользователя) и как сервер ограничивает пространства.
- Формат ответов инструментов MCP конкретного сервера (влияет только на `CONFLUENCE_MCP_RESULT_MAP`, не на код).
- Нужен ли прокси и разрешён ли прямой маршрут.
- Политика именования веток и меток MR в GitLab команды; кто ревьюер по умолчанию; стратегия merge (merge commit, squash, fast-forward) — влияет на подтверждение merge для публикации.
- Нужна ли интеграция с системой задач (пока «не подключено») и какой это продукт.
- Внутренняя модель: endpoint, лимиты контекста, политика хранения запросов — отдельное согласование, на этом этапе `AI_PROVIDER=mock`.
- Точная версия Confluence DC, context path, способ аутентификации (PAT), лимиты частоты запросов.
- Какие статусы документа допускают публикацию (`CONFLUENCE_PUBLISH_STATUSES`; по умолчанию только `approved`).
- Требования к хранению событий публикации и привязок (аудит, срок хранения).

## 8. Входные данные от корпоративных команд (live validation M4/M5)

Реальные токены в отчёты, чат и репозиторий не передаются: только файлы в `SKH_SECRETS_DIR` на стенде.

**GitLab**

| Что | Требование | Куда |
|---|---|---|
| GitLab endpoint | `https://gitlab.<corp>` без пути и учётных данных; DNS резолвится со стенда | `GITLAB_URL` |
| Test project ID | числовой ID или URL-кодированный путь тестового проекта | `GITLAB_PROJECT_ID` |
| Test branch | защищённая ветка знаний (обычно `main`): push запрещён, merge только через MR | `GITLAB_DEFAULT_BRANCH` |
| Каталог документов | например `docs`; документы по `docs/DOCUMENT_SCHEMA.md`, только синтетика `[TEST]` | `GITLAB_KNOWLEDGE_PATH` |
| Token scopes | этап A: `read_api`, роль Reporter; этап B (MR, отдельное разрешение): `api`, роль Developer; токен проекта или сервисной учётной записи, не персональный | файл `gitlab_token` |
| Стратегия merge | merge commit / squash / fast-forward / semi-linear — нужна для проверки подтверждения merge | протокол проверки |
| Corporate CA, DNS/egress/proxy | PEM корневого и промежуточного CA | `GITLAB_CA_BUNDLE` |

**Confluence MCP**

| Что | Требование | Куда |
|---|---|---|
| MCP endpoint | URL Streamable HTTP; поддерживаемая версия протокола (ожидается 2025-06-18) | `CONFLUENCE_MCP_URL` |
| Auth / доставка токена | Bearer-токен файлом; модель доступа `service_account` или `per_user` | `CONFLUENCE_MCP_AUTH_TOKEN_FILE`, `CONFLUENCE_MCP_AUTH_MODEL` |
| MCP tool mapping | реальный вывод `tools/list` и обезличенные примеры ответов поиска, чтения и метаданных → JSON для `CONFLUENCE_MCP_TOOL_MAP` (+ `RESULT_MAP` при отличии формата) | `integration.env` |
| Тестовое пространство | ключ `[TEST]`-пространства, ожидаемый вид ссылок на страницы, ограничения пространств | `CONFLUENCE_ALLOWLISTED_SPACES`, `CONFLUENCE_LINK_HOSTS`, `CONFLUENCE_WEB_BASE_URL` |
| TLS/CA | PEM | `CONFLUENCE_MCP_CA_BUNDLE` |

В режиме `service_account` нет гарантии пользовательских прав: только ограниченный однопользовательский контур до SSO.

**Confluence Data Center REST (публикация)**

| Что | Требование | Куда |
|---|---|---|
| Base URL и версия | точная версия Confluence DC; базовый URL с context path | `CONFLUENCE_REST_URL` |
| Test space key | только `[TEST]`-пространство, без реальной документации | `CONFLUENCE_TARGET_SPACE` |
| Parent page ID | числовой ID родительской страницы в этом пространстве | `CONFLUENCE_PARENT_PAGE_ID` |
| Publishing credentials | отдельная учётная запись и PAT, права из раздела 5 | файл `confluence_rest_token` → `CONFLUENCE_REST_TOKEN_FILE` |
| Ownership marker | согласие на content property `skh-managed-document` на тестовых страницах | — |
| Лимиты | ограничения частоты запросов и размера тела страницы | протокол |
| TLS/CA | PEM | `CONFLUENCE_REST_CA_BUNDLE` |

Порядок проверки — `docs/STAGING_TEST_RUNBOOK.md`; эксплуатация публикации — `docs/CONFLUENCE_SYNC_RUNBOOK.md`;
ограничения — `docs/PRODUCTION_BLOCKERS.md`.

## 9. Что придётся адаптировать после live validation

Подключение к реальной системе — **не** «подставить URL». Ниже — места, где поведение тестовых дублей
заведомо упрощено, и что делать, если реальная система ведёт себя иначе.

| Область | Как сейчас (проверено на дубле) | Риск на реальной системе | Возможная адаптация |
|---|---|---|---|
| Нормализация storage | Дубль только обрезает пробелы и приводит `<br/>`, `<hr/>`. Noop: если версия страницы не менялась с нашей публикации и новый рендер совпадает с `rendered_signature`; иначе сравнение подписи прочитанной страницы. Проверка после потерянного ответа сравнивает подпись; неоднозначный случай → `result_unknown` → dry-run и решение человека | Пересериализация XHTML (например, `ac:macro-id`) может давать `result_unknown` после потерянного ответа чаще, чем на дубле | Проверить на `[TEST]`-странице: нормализацию, сравнение подписи; при необходимости канонизировать атрибуты макросов |
| `metadata.properties` при создании | Дубль сохраняет свойство из тела создания | Версия DC может игнорировать `metadata.properties` | Уже есть запасной путь: отдельный `POST …/property`. Если он не пройдёт, задание `failed` с кодом `marker_write_failed` и ID страницы; страница не меняется — нужен регламент разбора |
| Подтверждение merge | `GET commits/:sha/merge_requests` для `last_commit_id` файла | Squash и rebase merge меняют SHA; для squash-коммита API может не вернуть MR → `not_merged` | Проверить на тестовом проекте с принятой стратегией merge; при необходимости брать доказательство из MR предложения (`merge_commit_sha`/`squash_commit_sha`) |
| Права учётной записи публикации | Дубль различает только «полный» и read-only токен (403 на запись) | Реальные ограничения пространства/страницы, restrictions на родителе | Проверить create/update/property под реальной учётной записью; описать минимальный набор прав |
| Лимиты частоты | GET повторяются при 429/5xx с учётом `Retry-After` (не дольше 5 с) | Жёсткие лимиты → ошибки dry-run | Согласовать лимиты |
| Context path и ссылки | Ссылка на страницу: `<CONFLUENCE_REST_URL>/pages/viewpage.action?pageId=…` | Другой context path, отдельный base URL для UI | Отдельная настройка web-адреса, если потребуется |
| Перемещение страницы | Перенос в другое пространство или под другого родителя (последний элемент `ancestors`) → конфликт `page_moved`; дубль учитывает `ancestors` при обновлении | Порядок `ancestors` в ответе реального DC | Проверить, что последний элемент — прямой родитель |
| Аутентификация | `Authorization: Bearer` (PAT) | Старые версии DC без PAT | Подтвердить версию; другой способ — только после решения ИБ |
| Размер и макросы | Код — макрос `code`, панель — макрос `info` | Ограничения на макросы/размер страницы | Проверить на `[TEST]`-странице |
| MCP | Имена инструментов и форма ответов — синтетические | Иной формат | Только `CONFLUENCE_MCP_TOOL_MAP` / `CONFLUENCE_MCP_RESULT_MAP`, без изменения UI |

## 10. Команды проверки

| Команда | Что делает | Сеть |
|---|---|---|
| `make preflight` / `python -m app.preflight` | офлайн-проверка текущей конфигурации, список исходящих хостов | нет |
| `make preflight-integration` | то же внутри контейнера с `integration.env` (см. пробел в разделе 1) | нет |
| `make readiness` / `python -m app.readiness [--json]` | read-only probe настроенных интеграций, метки `target`/`access` | да, только чтение |
| `make mock-up`, `make mock-readiness`, `make mock-e2e`, `make mock-down` | профиль `integration_mock` в Docker с тестовыми дублями | только внутренняя сеть Docker |
| `make test-live` | opt-in read-only смоук против тестового контура (`SKH_LIVE_TESTS=1`) | да, только чтение |
