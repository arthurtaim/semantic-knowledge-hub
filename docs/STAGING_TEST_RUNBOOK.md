# Runbook: проверка на тестовых GitLab и Confluence (этапы M4/M5 Live Validation)

Выполнять **только после** письменного разрешения на подключение и выдачи доступов (раздел 1).
Все данные — синтетические, страницы и документы с пометкой `[TEST]`. Реальных банковских документов
в тестовом проекте и тестовом пространстве быть не должно.

До выполнения этого runbook всё внешнее проверено **только на тестовых дублях** (GitLab-mock, MCP-mock,
Confluence-mock; `docs/M4_M5_INTEGRATION_READINESS.md`). Ни один пункт ниже ещё не выполнялся.

Этапы и разрешения:

| Этап | Что | Профиль | Разрешение |
|---|---|---|---|
| A | GitLab и Confluence MCP — только чтение | `live_read_only` | разрешение на подключение |
| A2 | Confluence DC REST — только чтение и dry-run | `live_read_only` | то же |
| B | GitLab — ветки, коммиты, MR (`update` и `create`) | `live_write_staging` | **отдельное** письменное разрешение |
| C | Confluence DC REST — создание/обновление страниц в `[TEST]`-пространстве | `live_write_staging` | **отдельное** письменное разрешение ИБ и владельца пространства |

## 1. Что должно быть выдано заранее
- Хост для тестового стенда (Linux, Docker Compose), без публикации наружу: UI доступен только на `127.0.0.1` хоста.
- Сетевой доступ с хоста **только** к тестовому GitLab (443), MCP-серверу (443) и — для этапов A2/C —
  Confluence DC (443); при необходимости — адрес прокси.
- PEM корпоративного CA, если сертификаты GitLab, MCP или Confluence выданы им.
- **GitLab:**
  - тестовый проект с защищённой веткой `main` (push запрещён, merge только через MR);
  - каталог `docs/` с синтетическими документами по `docs/DOCUMENT_SCHEMA.md`;
  - токен для чтения (scope `read_api`, роль Reporter);
  - отдельный токен для этапа записи (scope `api`, роль Developer) — только после отдельного разрешения (раздел 6);
  - сведения о стратегии merge в проекте (merge commit / squash / fast-forward).
- **Confluence MCP:**
  - URL эндпоинта Streamable HTTP и токен;
  - вывод `tools/list`;
  - пример ответа поиска и чтения страницы;
  - ключ тестового пространства;
  - описание модели доступа (сервисный токен или от имени пользователя).
- **Confluence DC REST (публикация):**
  - базовый URL с context path и точная версия Confluence DC;
  - ключ `[TEST]`-пространства и ID родительской страницы в нём;
  - отдельная учётная запись публикации и её PAT (не токен MCP); права — `docs/M4_M5_INTEGRATION_READINESS.md`, раздел 5;
  - для этапа C — письменное разрешение на запись именно в это пространство.

## 2. Подготовка (без сети)
```bash
git switch <ветка релиза> && make setup && make check        # всё зелёное офлайн
cp deploy/integration/integration.env.example deploy/integration/integration.env   # файл в .gitignore
mkdir -p ~/.config/skh-secrets && chmod 700 ~/.config/skh-secrets
# токены — файлами, без перевода строки в истории shell:
#   ~/.config/skh-secrets/gitlab_token, confluence_mcp_token, confluence_rest_token, (опц.) corporate-ca.pem
chmod 600 ~/.config/skh-secrets/*   # контейнер работает как uid 10001: chown 10001 или chmod 644 на закрытом хосте
export SKH_SECRETS_DIR=~/.config/skh-secrets
```
Заполнить в `integration.env`:
- `INTEGRATION_PROFILE=live_read_only`;
- `GITLAB_URL`, `GITLAB_PROJECT_ID`, `GITLAB_KNOWLEDGE_PATH=docs`, `GITLAB_CA_BUNDLE` (если нужен);
- `CONFLUENCE_MCP_URL`, `CONFLUENCE_ALLOWLISTED_SPACES`, `CONFLUENCE_LINK_HOSTS`, `CONFLUENCE_WEB_BASE_URL`;
- `CONFLUENCE_MCP_TOOL_MAP` — по реальному `tools/list`;
- `CONFLUENCE_MCP_RESULT_MAP` — если формат ответа отличается от умолчания;
- для этапа A2: `CONFLUENCE_REST_URL`, `CONFLUENCE_REST_TOKEN_FILE=/run/skh-secrets/confluence_rest_token`,
  `CONFLUENCE_REST_CA_BUNDLE`, `CONFLUENCE_TARGET_SPACE`, `CONFLUENCE_PARENT_PAGE_ID`.

`GITLAB_PROPOSALS_ENABLED=false`, `CONFLUENCE_PUBLISH_ENABLED=false`, `CONFLUENCE_PUBLISH_STAGING_ACK` пуст.

> **Перед первым запуском:** `docker-compose.integration.yml` сейчас не передаёт в контейнер
> `INTEGRATION_PROFILE` и переменные `CONFLUENCE_REST_*`/`CONFLUENCE_TARGET_SPACE`/`CONFLUENCE_PARENT_PAGE_ID`/
> `CONFLUENCE_PUBLISH_*` (пробел описан в `docs/M4_M5_INTEGRATION_READINESS.md`, раздел 1). Без исправления
> backend в контейнере работает в профиле `offline` и откажется стартовать. Проверка:
> `docker compose --env-file deploy/integration/integration.env -f docker-compose.yml -f docker-compose.integration.yml config`
> должен показать эти переменные в `services.backend.environment`.

## 3. Офлайн-проверка конфигурации
```bash
make preflight-integration    # в контейнере, без сетевых подключений
```
Ожидается: ошибок нет; `INTEGRATION_PROFILE live_read_only`; список исходящих хостов совпадает с согласованным
(GitLab, MCP, для A2 — Confluence DC REST); секреты показаны только как «задан (из файла)»; для Confluence
REST — «только dry-run (запись выключена) — РЕАЛЬНЫЙ сервер, live validation не проводилась». Предупреждения
про `local_demo` и сервисный токен MCP — ожидаемые.

## 4. Подключение корпоративного CA
- Файл PEM в `SKH_SECRETS_DIR`. В `integration.env`: `GITLAB_CA_BUNDLE=/run/skh-secrets/corporate-ca.pem`
  (и `CONFLUENCE_MCP_CA_BUNDLE`, `CONFLUENCE_REST_CA_BUNDLE`, `AI_CA_BUNDLE` при необходимости).
- Проверка TLS не отключается. `http` для реальных хостов запрещён при старте; в профилях `live_*` разрешён только `https`.
- Ошибка CA видна в preflight («файл CA найден и читается») и в статусе интеграции (ошибка TLS).

## 5. Этап A — только чтение (первый запуск)
```bash
make readiness                       # read-only probe: GitLab проект/ветка, MCP initialize + tools/list
make integration-up
SKH_LIVE_TESTS=1 make test-live      # read-only smoke: статус, список, документ, поиск MCP
```
`make readiness` выполняет только запросы чтения и печатает для каждой интеграции состояние, `target`
(должно быть «реальный сервер») и `access`. Успех — это доступность, а не live validation.

| # | Проверка | Ожидаемо | Протокол |
|---|---|---|---|
| A1 | «Интеграции»: GitLab | «Подключено», `target=real`, `access=read`, имя тестового проекта, ветка `main` | скриншот |
| A2 | «Интеграции»: синхронизация | `fresh`, число документов = числу `.md` в `docs/` | `/api/index/status` |
| A3 | Документ | ревизия = SHA коммита; дата = дате коммита; «Открыть в GitLab» ведёт на эту ревизию | сверка с GitLab UI |
| A4 | Изменить документ в GitLab (через MR), «Синхронизировать сейчас» | новая ревизия, поиск находит новый текст | — |
| A5 | Удалить тестовый документ в GitLab | пропал из каталога и поиска | — |
| A6 | Пагинация | при числе файлов больше 100 все документы видны (keyset или offset) | — |
| A7 | Неверный токен | ошибка авторизации, документы не показываются (fail closed) | — |
| A8 | Временно закрыть egress к GitLab | документы помечены «могут быть устаревшими», статус `stale` | — |
| A9 | Confluence MCP | «Подключено», `target=real`, инструменты сопоставлены; поиск только по разрешённому пространству | — |
| A10 | Несовпадение `CONFLUENCE_MCP_TOOL_MAP` | понятная ошибка «инструмент не объявлен сервером» (`mcp_tool_missing`) | — |
| A11 | Ответ ассистента с корпоративным источником | цитата: Confluence, ID страницы, версия, ссылка на разрешённый хост | — |
| A12 | Журналы контейнера | нет токенов, тел документов и путей файлов | `docker compose logs` |

Проверки MCP, которые на stateful MCP-mock проходят (`backend/tests/test_mcp_mock_contract.py`) и которые
нужно подтвердить на реальном сервере:

| # | Проверка | Поведение на тестовом дубле |
|---|---|---|
| A13 | `tools/list` с несколькими страницами (`nextCursor`) | все инструменты обнаружены, сессия закрывается `DELETE` |
| A14 | Сервер вернул страницу из неразрешённого пространства | страница отброшена, в ответ и цитаты не попадает |
| A15 | Страница изменена в Confluence | повторное чтение показывает новую версию; цитата содержит версию |
| A16 | Ответы JSON и SSE | оба формата разбираются одинаково |
| A17 | Ошибки: 401, недоступность, некорректный JSON, JSON-RPC error, таймаут | явный статус (`mcp_auth_failed`, `mcp_http_error`, `mcp_invalid_response`, `mcp_rpc_error`, `mcp_timeout`), без подмены результата |
| A18 | `isError` при чтении страницы | «не найдено», а не фиктивная страница |

Рекомендуется записать **обезличенные** ответы MCP в `fixtures/integration/confluence_mcp/` (только
синтетика) — replay-тесты подхватят их без изменения кода. Отличия формата ответов исправляются только в
`CONFLUENCE_MCP_TOOL_MAP` / `CONFLUENCE_MCP_RESULT_MAP`.

## 5a. Этап A2 — Confluence DC REST: только чтение и dry-run

Профиль остаётся `live_read_only`, `CONFLUENCE_PUBLISH_ENABLED=false`. Запись невозможна: публикатор работает
в режиме `dry_run_only`, `publish` отвечает `503 publish_disabled`.

```bash
make readiness      # Confluence REST: чтение пространства и родительской страницы
```

| # | Проверка | Ожидаемо |
|---|---|---|
| C1 | «Интеграции»: «Confluence Data Center (REST, публикация)» | «Подключено», `target=real`, `access=read`, возможности `read_pages`, `dry_run` (без `create_page`) |
| C2 | Неверный `CONFLUENCE_TARGET_SPACE` / `CONFLUENCE_PARENT_PAGE_ID` | статус «Ошибка»: пространство или родитель не найдены |
| C3 | Неверный токен публикации | `confluence_auth_failed`, ничего не записано |
| C4 | Документ, смёрженный через MR в тестовом проекте: `POST /api/documents/<ID>/publication/prepare` | задание `dry_run_ready`, `plan.merge_request` заполнен, `action=create` |
| C5 | Документ, закоммиченный в `main` без MR (если такой есть) | `failed`, `not_merged` |
| C6 | Документ со статусом не из `CONFLUENCE_PUBLISH_STATUSES` | `failed`, `status_not_publishable` |
| C7 | В пространстве вручную создана страница с тем же заголовком (без метки) | `conflict`, `title_taken` |
| C8 | Журнал запросов Confluence за время C4–C7 | **только GET** (журнал `skh.confluence.rest` и журнал доступа Confluence) |
| C9 | Документ с изображением, диаграммой, внутренней ссылкой | предупреждения в предпросмотре |
| C10 | Стратегия merge проекта (merge commit / squash / fast-forward) | `merge_request` находится для `last_commit_id` файла; для squash — зафиксировать фактическое поведение |

## 6. Этап B — запись в GitLab (MR), только по отдельному разрешению
1. Выдать токен с scope `api` (роль Developer). Убедиться, что `main` защищена: push запрещён, merge только через MR.
2. `INTEGRATION_PROFILE=live_write_staging`, `GITLAB_PROPOSALS_ENABLED=true`, `APP_PUBLIC_URL=http://127.0.0.1:5173`, перезапуск.
3. Сценарий изменения: предложение → «Готово к ревью» → «Отправить в GitLab» → в GitLab появились ветка
   `kb/update/<ID>-…`, один коммит с `Proposal-Id`, `Operation: update`, `Base-Revision`, MR `Draft:` в `main`.
   Описание содержит документ, причину и базовую ревизию.
4. Повторная отправка → новый MR не создан.
5. Конфликт: изменить файл в `main` до отправки → статус «Конфликт версий», ничего не записано.
6. Merge MR ревьюером в GitLab → «Проверить статус» → «Принято (merge)», база знаний показывает новую ревизию,
   в предложении заполнены ревизия после merge и время синхронизации.
7. Закрыть MR без merge → «Отклонено».
8. Новый документ: «Создать документ» → шаблон → черновик → «Отправить на ревью» → «Отправить в GitLab» →
   ветка с одним коммитом `create` (`Operation: create`), MR `Draft: [новый] <ID> — …`. До merge документа нет в
   каталоге и поиске; после merge и «Проверить статус» — есть.
9. Конфликт создания: до отправки добавить в `main` файл с тем же путём → `document_exists`, чужой файл не тронут.
10. Проверить в журнале аудита GitLab, что в `main` не было прямых push.

## 7. Этап C — публикация в `[TEST]`-пространство, только по отдельному письменному разрешению

Предусловия: этапы A, A2 и B пройдены; письменное разрешение на запись в конкретное пространство; учётная
запись публикации имеет доступ только к нему; сделана резервная копия `publications.sqlite3`
(`docs/CONFLUENCE_SYNC_RUNBOOK.md`, раздел 10).

Конфигурация:
```text
INTEGRATION_PROFILE=live_write_staging
CONFLUENCE_PUBLISH_ENABLED=true
CONFLUENCE_PUBLISH_STAGING_ACK=<тот же ключ, что CONFLUENCE_TARGET_SPACE>
CONFLUENCE_REST_CA_BUNDLE=/run/skh-secrets/corporate-ca.pem
```
Без совпадающего `CONFLUENCE_PUBLISH_STAGING_ACK` и CA backend не стартует. `make preflight-integration`
должен показать «запись разрешена — РЕАЛЬНЫЙ сервер, live validation не проводилась».

| # | Сценарий | Ожидаемо |
|---|---|---|
| W1 | Опубликовать задание `dry_run_ready` (`action=create`) | одна новая страница под родителем; content property `skh-managed-document` с ID документа и проекта; версия 1 |
| W2 | Повторить `prepare` + публикацию той же ревизии | `noop`, новой версии нет. **Если появилась новая версия — зафиксировать** (нормализация storage, раздел 9 документа готовности) |
| W3 | Изменение документа через MR → merge → публикация | та же страница, версия +1 |
| W4 | Ручная правка страницы в Confluence → новое изменение через MR | `conflict`, `manual_edit`, diff показывает правку; страница не изменена |
| W5 | «Подтвердить учёт ручной правки» → предпросмотр → публикация | diff показывает заменяемое; после публикации версия +1 |
| W6 | Перенос страницы в другое пространство | `conflict`, `page_moved` |
| W7 | Отзыв права на редактирование у учётной записи | `failed`, `confluence_forbidden`; merge в GitLab не затронут |
| W8 | Метка: прочитать content property через Confluence | значение совпадает с `docs/CONFLUENCE_MAPPING.md`, раздел 3 |
| W9 | Создание страницы, если DC игнорирует `metadata.properties` | метка записана отдельным запросом; зафиксировать фактическое поведение |
| W10 | Перезапуск backend во время публикации (если удаётся воспроизвести) | задание `result_unknown`, «Проверить результат» определяет итог без дубликата |
| W11 | Журналы backend | нет токенов и текстов страниц |

Отличия от поведения тестового дубля фиксируются в протоколе и разбираются до любого расширения записи.

## 8. Проверка безопасности
- Порт UI опубликован только на `127.0.0.1` (`docker compose ps`). Backend не опубликован.
- С хоста: egress только к согласованным хостам (проверка сетевыми средствами ИБ, а не приложением).
- В репозитории нет `integration.env` и секретов (`git status`, `make check` → тесты гигиены).
- `/api/session` → `authorization_policy=local_demo_single_operator`. Доступ к стенду только у тестирующего.
- MCP с сервисным токеном: подтверждено, что в тестовом пространстве нет данных с ограниченным доступом.
- Токен MCP и токен публикации — разные; учётная запись публикации не видит других пространств.

## 9. Откат
1. `docker compose -f docker-compose.yml -f docker-compose.integration.yml down`
   — стенд остановлен, исходящие соединения прекращены.
2. Отозвать или ротировать токены GitLab, MCP и публикации. Удалить файлы секретов из `SKH_SECRETS_DIR`.
3. Закрыть или удалить тестовые MR и ветки `kb/update/*` в GitLab (приложение их не удаляет).
4. Удалить или архивировать тестовые страницы в `[TEST]`-пространстве (приложение страницы не удаляет).
5. `make reset-workspace` — удалить локальный индекс, предложения и привязки публикации (это копии
   синтетических документов). Перед этим, если нужно, сохранить копию `publications.sqlite3`.
6. Вернуться к офлайн-режиму: `make up` (без override) — внешних подключений нет.

## 10. Результат этапа
Протокол: таблицы A1–A18, C1–C10 (и B, W, если выполнялись), версии GitLab, MCP-сервера и Confluence DC,
стратегия merge, отличия от поведения тестовых дублей (нормализация storage, `metadata.properties`, права,
лимиты, ссылки), изменения конфигурации. До протокола интеграции считаются **не проверенными** на реальной
системе (PB-05, PB-12).
