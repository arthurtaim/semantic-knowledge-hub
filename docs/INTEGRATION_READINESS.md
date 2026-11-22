# Готовность к подключению корпоративных систем (тестовый контур)

Документ для инфраструктурной команды, администраторов GitLab/Confluence и команды семантического слоя. Он описывает, что нужно, чтобы подключить Semantic Knowledge Hub к **тестовым** GitLab и Confluence Data Center (через MCP) и что уже проверено.

**Текущий статус (2026-11-22).** Адаптеры реализованы и покрыты контрактными тестами на фейковых серверах и тестами на записанных ответах. С реальными системами соединений не было. Запись в Confluence не реализована и выключена; запись в GitLab (ветка + MR) реализована, но выключена до отдельного решения.

## 1. Как будет устроено подключение

```text
браузер ──127.0.0.1──> nginx (frontend) ──internal──> backend ──egress (только в тестовом контуре)──> GitLab REST v4
                                                                                                └──> Confluence MCP (Streamable HTTP)
секреты: файлы вне репозитория ──(read-only mount /run/skh-secrets)──> backend
```

- Конфигурация — `deploy/integration/integration.env` (копия шаблона `integration.env.example`, в git не попадает).
- Секреты — только файлами в каталоге вне репозитория (`SKH_SECRETS_DIR`), подключаются через `*_FILE`. Значения нигде не логируются и не выводятся.
- Корпоративный CA — `GITLAB_CA_BUNDLE`, `CONFLUENCE_MCP_CA_BUNDLE`, `AI_CA_BUNDLE` (PEM).
- Системные `HTTP(S)_PROXY` намеренно игнорируются (`trust_env=False`), запросы идут только на явно настроенные хосты. Если нужен прокси — см. раздел 6.

## 2. Порядок первого подключения (только чтение)

1. Инфраструктура выполняет пункты раздела 6, команда получает значения из раздела 4.
2. `cp deploy/integration/integration.env.example deploy/integration/integration.env`, заполнить; секреты положить в `SKH_SECRETS_DIR`.
3. `export SKH_SECRETS_DIR=…; make preflight-integration` — офлайн-проверка в контейнере: ошибки конфигурации и список хостов, к которым backend будет обращаться. Соединений не выполняет.
4. Узнать имена инструментов MCP: администратор MCP предоставляет вывод `tools/list` (или страница «Интеграции» после запуска покажет обнаруженные инструменты). Заполнить `CONFLUENCE_MCP_TOOL_MAP`, при необходимости `CONFLUENCE_MCP_RESULT_MAP`.
5. `make integration-up` — запуск; на странице «Интеграции» статусы GitLab и Confluence MCP должны стать «Подключено» (только после реальной проверки).
6. `make test-live` — read-only смоук: чтение документов GitLab и поиск в разрешённых пространствах. Ничего не записывает.
7. Обезличенные ответы MCP тестового пространства (синтетические страницы `[TEST]`) добавить как сценарий в `fixtures/integration/confluence_mcp/` — см. README там.
8. Только после этого и отдельного решения — этап 2: `GITLAB_PROPOSALS_ENABLED=true` на тестовом проекте.

## 3. Соответствие официальным контрактам

### GitLab REST API v4
Проверено по документации docs.gitlab.com (repositories, repository_files, branches, commits, merge_requests, rest, authentication) 2026-11-22; поведение закреплено тестами `backend/tests/test_gitlab.py` на фейковом GitLab.

| Операция | Запрос | Соответствие и обработка |
|---|---|---|
| Проверка доступа | `GET /projects/:id` + `GET /projects/:id/repository/branches/:branch` с `PRIVATE-TOKEN` | Проект может отвечать без авторизации, поэтому дополнительно проверяется ветка — она требует прав на чтение репозитория |
| Список документов | `GET /projects/:id/repository/tree?ref&recursive=true&path&per_page=100&pagination=keyset` | Keyset-пагинация, как рекомендует GitLab; из заголовка `Link` берётся только `page_token`, сам URL не используется. Запасной вариант — offset (`X-Next-Page`) |
| Чтение файла | `GET /projects/:id/repository/files/:file_path?ref` (путь кодируется, `/` → `%2F`) | Поля `size`, `encoding=base64`, `content`, `last_commit_id`. Ревизия документа = `last_commit_id` (SHA последнего коммита, изменившего файл) |
| Ветка предложения | `POST /projects/:id/repository/branches?branch&ref` | Ответ «ветка уже существует» не документирован → при ошибке существование проверяется явным `GET` ветки |
| Коммит | `POST /projects/:id/repository/commits` с `actions[{action:update, file_path, content, last_commit_id}]` | `last_commit_id` — проверка, что файл не изменился. Отказ GitLab (400) не документирован детально → решение по фактической ревизии файла: конфликт или ошибка |
| Поиск MR | `GET /projects/:id/merge_requests?source_branch&state=all` | `state=all`: закрытый ревьюером MR не пересоздаётся |
| Создание MR | `POST /projects/:id/merge_requests` (`source_branch`, `target_branch`, `title` с префиксом `Draft:`, `description`, `remove_source_branch`) | Ответ на дубликат не документирован → при любой ошибке ищется существующий MR. Префикс `Draft:` делает MR черновиком (документация GitLab о draft MR) |
| Ограничение частоты | `429` + `Retry-After` | Учитывается (не более 5 с). Повторяются только GET; POST не повторяется, чтобы не продублировать коммит |

### MCP (спецификация 2025-06-18, Streamable HTTP)
Проверено по modelcontextprotocol.io (transports, lifecycle, tools); тесты `backend/tests/test_confluence_mcp.py` и `backend/tests/integration/test_confluence_mcp_replay.py`.

- Каждое сообщение — `POST` на один endpoint с `Accept: application/json, text/event-stream`; поддерживаются оба формата ответа.
- `initialize` → `notifications/initialized` (ожидается 202) → запрос → `DELETE` с `Mcp-Session-Id` для завершения сессии; `MCP-Protocol-Version: 2025-06-18` в последующих запросах.
- `tools/list` с переходом по `nextCursor`; имена инструментов и аргументы проверяются по `inputSchema` и никогда не угадываются.
- `tools/call`: `isError: true` — ошибка выполнения (для чтения страницы трактуется как «не найдено/нет доступа»); JSON-RPC `error` — ошибка протокола.
- Результат: `structuredContent` или JSON в текстовом блоке; поля страницы ищутся по `CONFLUENCE_MCP_RESULT_MAP` (по умолчанию — распространённые варианты, включая вложенный формат поиска Confluence).

Что **не** проверено: реальные ответы конкретного MCP-сервера банка (имена инструментов, формат результатов, передача пользователя), поведение реального GitLab на ошибках, отмеченных выше как недокументированные.

## 4. Параметры

| Параметр | Назначение | Формат / пример | Кто предоставляет | Секрет |
|---|---|---|---|---|
| `GITLAB_URL` | Адрес тестового GitLab | `https://gitlab.test.<домен>` | Администраторы GitLab | нет |
| `GITLAB_PROJECT_ID` | Тестовый проект базы знаний | `1234` или `group%2Fknowledge-test` | Администраторы GitLab | нет |
| `GITLAB_DEFAULT_BRANCH` | Защищённая основная ветка | `main` | Команда | нет |
| `GITLAB_KNOWLEDGE_PATH` | Каталог документов в репозитории | `knowledge` или пусто | Команда | нет |
| `GITLAB_TOKEN_FILE` | Файл с токеном (см. раздел 5) | `/run/skh-secrets/gitlab_token` | Администраторы GitLab | **да** |
| `GITLAB_CA_BUNDLE` | Корпоративный CA для TLS | `/run/skh-secrets/corporate-ca.pem` | Инфраструктура | нет |
| `CONFLUENCE_MCP_URL` | Endpoint утверждённого MCP-сервера | `https://mcp.test.<домен>/mcp` | Владельцы MCP-сервиса | нет |
| `CONFLUENCE_MCP_AUTH_TOKEN_FILE` | Файл с токеном MCP (Bearer) | `/run/skh-secrets/confluence_mcp_token` | Владельцы MCP-сервиса | **да** |
| `CONFLUENCE_MCP_CA_BUNDLE` | CA для TLS к MCP | PEM | Инфраструктура | нет |
| `CONFLUENCE_ALLOWLISTED_SPACES` | Разрешённые пространства | `SKHTEST` | Администраторы Confluence | нет |
| `CONFLUENCE_MCP_TOOL_MAP` | Сопоставление поиска/чтения с инструментами | JSON (см. шаблон) | По выводу `tools/list` | нет |
| `CONFLUENCE_MCP_RESULT_MAP` | Где в ответе id/space/title/url | JSON, опционально | По примеру ответа | нет |
| `CONFLUENCE_LINK_HOSTS` | Хосты, на которые можно ссылаться | `confluence.test.<домен>` | Администраторы Confluence | нет |
| `CONFLUENCE_WEB_BASE_URL` | База для относительных ссылок | `https://confluence.test.<домен>` | Администраторы Confluence | нет |
| `GITLAB_PROPOSALS_ENABLED` | Запись: ветка + коммит + MR | `false` на этапе 1 | Решение владельца продукта | нет |
| `CONFLUENCE_PUBLISH_ENABLED` | Публикация (M5) | всегда `false` | — | нет |
| `AI_*` | Внутренняя модель (отдельное согласование) | `AI_PROVIDER=mock` по умолчанию | Владельцы AI-платформы | ключ — да |
| `SKH_SECRETS_DIR` | Каталог секретов на хосте (вне репозитория) | `~/.config/skh-secrets` | Оператор стенда | — |
| `GITLAB_REFRESH_SECONDS` | Как часто проверять head ветки при обращении к данным | `60` | Команда | нет |
| `CONFLUENCE_MCP_AUTH_MODEL` | Модель доступа MCP | `service_account` (единственная разрешённая сейчас) | Владельцы MCP-сервиса | нет |
| `APP_PUBLIC_URL` | Ссылка на предложение в описании MR | `http://127.0.0.1:5173` (только loopback в `local_demo`) | Оператор стенда | нет |

Имена из задания M4.5 и действующий контракт (новые синонимы не вводились, чтобы не дублировать конфигурацию — ADR-018):

| В задании | В приложении |
|---|---|
| `KNOWLEDGE_PROVIDER=local\|gitlab` | `KNOWLEDGE_BACKEND=local\|gitlab` |
| `GITLAB_BASE_URL` | `GITLAB_URL` |
| `GITLAB_DOCS_PATH` | `GITLAB_KNOWLEDGE_PATH` |
| `GITLAB_PROJECT_ID`, `GITLAB_DEFAULT_BRANCH`, `GITLAB_TOKEN_FILE`, `GITLAB_CA_BUNDLE` | без изменений |

## 5. Доступы и права

**GitLab (тестовый проект):**
- Этап 1 (чтение): токен проекта/группы или сервисной учётной записи со scope `read_api` (достаточно для repository tree/files); роль в проекте не ниже Reporter. Персональные токены сотрудников не использовать.
- Этап 2 (предложения): scope `api`, роль Developer; основная ветка защищена (merge только Maintainer/по правилам approval), push в неё для токена запрещён. Приложение коммитит только в ветки `kb/update/<ID>-<suffix>` и открывает Draft MR (`docs/GITLAB_KNOWLEDGE_WORKFLOW.md`).
- Срок жизни токена и процедура ротации — по политике банка; токен кладётся файлом, перезапуск подхватывает новый.

**Confluence Data Center через MCP:**
- Отдельное тестовое пространство (например, `SKHTEST`) только с синтетическими страницами `[TEST]`.
- MCP-сервер в режиме только чтения; доступ сервисной учётной записи ограничен тестовым пространством.
- Нужно подтвердить модель авторизации: сервисный токен (тогда приложение остаётся однопользовательским — так требует docs/INTEGRATIONS.md) или передача пользователя (per-user ACL — обязательна для многопользовательского режима, ещё не реализована).
- Публикация (запись) не запрашивается.

## 6. Что нужно от инфраструктурной команды

- [ ] Хост/ВМ для тестового стенда с Docker Compose v2 (или согласованная альтернатива), без публикации наружу: UI слушает только `127.0.0.1`.
- [ ] Сетевой доступ **только** с этого хоста: к тестовому GitLab (443/TCP) и к MCP-серверу Confluence (порт сервиса). Больше ничего; интернет не нужен.
- [ ] Если прямого маршрута нет — параметры корпоративного прокси (приложение сейчас прокси не использует; потребуется явная настройка, ~0,5 дня работы).
- [ ] PEM-файл корпоративного корневого/промежуточного CA, которым подписаны сертификаты GitLab и MCP.
- [ ] DNS-имена тестовых GitLab и MCP, резолвящиеся с хоста стенда.
- [ ] Способ доставки секретов на хост (vault agent, файл с правами 600/0640 для uid 10001 или Docker/K8s secrets) и процедура ротации.
- [ ] Тестовый проект GitLab + токен (раздел 5), защищённая ветка `main`, синтетические документы в формате `docs/DOCUMENT_SCHEMA.md`.
- [ ] Endpoint MCP-сервера Confluence DC, его токен, вывод `tools/list` и пример ответа поиска/чтения на тестовом пространстве.
- [ ] Тестовое пространство Confluence с синтетическими страницами и учётная запись с доступом только к нему.
- [ ] Требования к журналам: куда собирать stdout контейнеров, срок хранения (журналы не содержат тел запросов и токенов).
- [ ] Подтверждение, что на тестовом контуре нет реальных банковских данных, и согласование выхода в сеть со службой ИБ.

## 7. Открытые вопросы
- Модель авторизации MCP (сервисный токен или передача пользователя) и как сервер ограничивает пространства.
- Формат ответов инструментов MCP конкретного сервера (влияет только на `CONFLUENCE_MCP_RESULT_MAP`, не на код).
- Нужен ли прокси и разрешён ли прямой маршрут.
- Политика именования веток и меток MR в GitLab команды; кто ревьюер по умолчанию.
- Нужна ли интеграция с системой задач (пока «не подключено») и какой это продукт.
- Внутренняя модель: endpoint, лимиты контекста, политика хранения запросов — отдельное согласование, на этом этапе `AI_PROVIDER=mock`.

## 8. Входные данные для этапа M4 Live Integration Validation

Реальные токены в отчёты и в репозиторий не передаются: только файлы в `SKH_SECRETS_DIR` на стенде.

| Что | Требование | Куда |
|---|---|---|
| GitLab endpoint | `https://<test-gitlab-host>` без пути и учётных данных; DNS резолвится со стенда | `GITLAB_URL` |
| Test project ID | числовой ID или URL-кодированный путь тестового проекта | `GITLAB_PROJECT_ID` |
| Test branch | защищённая ветка знаний (обычно `main`): push запрещён, merge только через MR | `GITLAB_DEFAULT_BRANCH` |
| Каталог документов | например `docs`; документы по `docs/DOCUMENT_SCHEMA.md`, только синтетика `[TEST]` | `GITLAB_KNOWLEDGE_PATH` |
| Token scopes | этап A: `read_api`, роль Reporter; этап B (MR, отдельное разрешение): `api`, роль Developer; токен проекта или сервисной учётной записи, не персональный | файл `gitlab_token` |
| Corporate CA | PEM корневого и промежуточного CA для GitLab, MCP (и AI) | `*_CA_BUNDLE` |
| MCP endpoint | URL Streamable HTTP (MCP 2025-06-18) | `CONFLUENCE_MCP_URL` |
| MCP tool mapping | вывод `tools/list` и примеры ответов поиска и чтения → JSON для `CONFLUENCE_MCP_TOOL_MAP` (+ `RESULT_MAP` при отличии формата) | `integration.env` |
| Authentication model | MCP: сервисный токен (только однопользовательский контур) или передача пользователя (нужен SSO, не реализовано); GitLab: сервисный токен | `CONFLUENCE_MCP_AUTH_MODEL`, решение ИБ |
| Network requirements | со стенда только 443/TCP к GitLab и MCP (и AI, если согласован); без интернета; прокси — если обязателен (сейчас не поддерживается, ~0,5 дня работы) | правила МЭ / ИБ |
| Тестовое пространство Confluence | ключ пространства, только синтетические страницы, учётная запись с доступом только к нему | `CONFLUENCE_ALLOWLISTED_SPACES`, `CONFLUENCE_LINK_HOSTS`, `CONFLUENCE_WEB_BASE_URL` |

Порядок проверки — `docs/STAGING_TEST_RUNBOOK.md`; ограничения — `docs/PRODUCTION_BLOCKERS.md`.
