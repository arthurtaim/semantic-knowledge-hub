# Публикация в Confluence Data Center (M5): архитектура

Статус: реализовано. Проверено локально (pytest) и на stateful тестовом дубле Confluence DC REST
(`backend/tests/support/confluence_mock.py`), в том числе в Docker-профиле `integration_mock` (`make mock-e2e`).
С реальным Confluence Data Center **не проверялось**, запись в реальный Confluence **не включалась**
(`docs/M4_M5_INTEGRATION_READINESS.md`, раздел 9).

Публикация — односторонняя: утверждённая (смёрженная) ревизия документа из GitLab → одна страница в одном
настроенном пространстве Confluence. GitLab остаётся источником истины (ADR-004). Привязка документ → страница —
`docs/CONFLUENCE_MAPPING.md`; эксплуатация — `docs/CONFLUENCE_SYNC_RUNBOOK.md`.

## 1. Компоненты

```text
ProposalService._sync_after_merge ──(после подтверждённого merge и синхронизации)──▶ PublicationService.on_document_merged
API /api/documents/{id}/publication*, /api/publications/jobs*  ──▶ PublicationService
                                                                     │
          ┌──────────────────────────┬───────────────────────────────┼────────────────────────────┐
          ▼                          ▼                               ▼                            ▼
 KnowledgeRepository        GitLabKnowledgeRepository        render_storage (Markdown →     ConfluencePublisher
 (документ, текущая         .merged_merge_request            storage, ошибки/предупреждения)  ├ DisabledConfluencePublisher
  ревизия в GitLab)         (доказательство merge)                                           └ ConfluenceRESTPublisher
                                                                                                    │
                                                                                             ConfluenceDCClient ──▶ /rest/api
 PublicationStore (SQLite `publications.sqlite3`): publication_jobs · publication_mappings · publication_events
```

| Компонент | Файл | Ответственность |
|---|---|---|
| Рендерер storage | `backend/app/domain/confluence_storage.py` (`render_storage`, `storage_signature`) | Markdown → Confluence DC storage format; экранирование; ошибки и предупреждения до публикации |
| REST-клиент DC | `backend/app/adapters/confluence_rest/client.py` (`ConfluenceDCClient`) | `/rest/api` Data Center (не Cloud v2): пространство, страница, поиск по заголовку, content property, создание, обновление; повторяет только GET; токены и тела не логирует |
| REST-публикатор | `backend/app/adapters/confluence_rest/publisher.py` (`ConfluenceRESTPublisher`) | ровно одно пространство и родитель из конфигурации; чтение всегда, запись — только при `write_enabled`; ключ метки `skh-managed-document` |
| Выключенный публикатор | `backend/app/adapters/publishers/disabled.py` | `CONFLUENCE_REST_URL` пуст: статус «Не настроено», любые вызовы → `publication_disabled` |
| Сервис публикации | `backend/app/services/publications.py` (`PublicationService`) | задания, dry-run, публикация, сверка после потерянного ответа, подтверждение ручной правки, восстановление после перезапуска |
| Хранилище | там же (`PublicationStore`) | durable-задания, привязки, бессодержательный журнал событий |
| API | `backend/app/api/publications.py` | маршруты; ни один не принимает page ID и тело запроса |
| Права | `backend/app/authz.py` | `prepare_publication` (задания, dry-run, сверка — только чтение Confluence), `publish_confluence` (запись и подтверждение ручной правки) |
| Подтверждение merge | `backend/app/adapters/gitlab/repository.py` (`merged_merge_request`) | `GET /projects/:id/repository/commits/:sha/merge_requests` |

Публикация отделена от `KnowledgeProvider`, AI-провайдера и жизненного цикла MR: она только читает документ
и состояние GitLab и никогда их не меняет.

## 2. Почему REST, а не MCP

- MCP-коннектор — утверждённый **read-only** канал корпоративного поиска (ADR-003). Его инструменты и формат
  ответа берутся из `tools/list` и не гарантируют операций записи, версий и content property.
- Запись требует контролируемых операций Confluence Data Center REST: версия `+1`, `409` при конфликте,
  content property для метки владельца, точный storage format.
- Разделение учётных данных: публикация использует **отдельный** токен (`CONFLUENCE_REST_TOKEN(_FILE)`);
  совпадение с токеном MCP блокирует запуск. Компрометация или расширение прав одного канала не даёт записи
  через другой.
- Cloud REST API v2 не используется: целевая система — Data Center.

## 3. Автомат состояний задания

Задание публикации привязано к **конкретной ревизии** документа (SHA коммита в GitLab).

```text
                prepare / post-merge hook
                          │
                          ▼
   ┌──────────────▶ pending ──dry-run──▶ validating ──▶ dry_run_ready ──publish──▶ publishing ──▶ published
   │                  ▲                    │   │              │                       │
   │   (сбой чтения)  └────────────────────┘   │              │ (план изменился:      ├─ 409 ─────────────▶ conflict
   │                                           │              │  409 plan_changed)    ├─ ошибка ──────────▶ failed
   │                                           ├─▶ failed     │                       ├─ ответ потерян ─▶ проверка:
   │                                           └─▶ conflict   │                       │    применено → published
   │                                                          │                       │    не применено → failed
   │   reconcile / dry-run                                    │                       │    неизвестно → result_unknown
   └──────────── failed, conflict ◀───────────────────────────┘                       └─ перезапуск ──▶ result_unknown
                 result_unknown ──reconcile──▶ (проверка) published | failed → dry-run
   новая ревизия документа: активное задание (pending, validating, dry_run_ready) ──▶ superseded
```

| Состояние | Смысл | Доступные действия |
|---|---|---|
| `pending` | задание создано (после merge и синхронизации или по запросу), ничего не проверено | dry-run |
| `validating` | выполняется dry-run (только чтение) | — |
| `dry_run_ready` | предпросмотр готов, блокирующих проблем нет | «Опубликовать» (если запись разрешена), повторный dry-run |
| `publishing` | идёт запись в Confluence | — |
| `published` | Confluence подтвердил страницу и версию (или изменений не требовалось — `noop`) | новый `prepare` |
| `conflict` | страница изменена вручную, принадлежит не этому документу, заголовок занят, страница пропала или перенесена; ничего не записано | сверка/повторный dry-run; для ручной правки — подтверждение её учёта |
| `failed` | заблокировано проверкой или определённой ошибкой; безопасно повторить после устранения причины | сверка/повторный dry-run |
| `result_unknown` | запись могла произойти; следующий шаг — проверка Confluence, повтор вслепую запрещён | «Проверить результат» (`reconcile`) |
| `superseded` | заменено заданием для более новой ревизии | — |

Флаги в ответе задания: `can_dry_run` (`pending`, `dry_run_ready`, `failed`, `conflict`), `can_publish`
(запись разрешена, `dry_run_ready`, план без проблем, действие `create`/`update`/`noop`), `can_reconcile`
(`result_unknown`, `failed`, `conflict`), `publish_enabled`, `publish_disabled_reason`.

### Состояние публикации документа (производное)

`GET /api/documents/{id}/publication` вычисляет одно состояние для документа:

| Состояние | Условие |
|---|---|
| `disabled` | публикация не настроена (`CONFLUENCE_REST_URL` пуст) |
| `pending` / `validating` / `dry_run_ready` / `publishing` / `result_unknown` | последнее задание документа активно — показывается его состояние |
| `conflict` / `failed` | последнее задание в этом состоянии и оно новее последней успешной публикации (или публикаций не было) |
| `published` | есть привязка, и опубликованная ревизия равна текущей ревизии документа |
| `outdated` | есть привязка, но опубликована более ранняя ревизия |
| `not_published` | привязки нет, активных/проблемных заданий нет |

`can_prepare` = публикация настроена и последнее задание не в `publishing`/`result_unknown`.

## 4. Проверки до публикации

Выполняются при каждом dry-run и повторно непосредственно перед записью:

| Проверка | Код проблемы (блокирует) |
|---|---|
| Текущая ревизия файла в GitLab совпадает с ревизией задания | `revision_superseded` |
| GitLab подтверждает, что ревизия попала в ветку знаний через **смёрженный** MR: `GET /projects/:id/repository/commits/:sha/merge_requests` вернул MR со `state=merged` и `target_branch` = `GITLAB_DEFAULT_BRANCH` | `not_merged` (в том числе для локального workspace — «нужен GitLab») |
| Статус документа входит в `CONFLUENCE_PUBLISH_STATUSES` (по умолчанию только `approved`) | `status_not_publishable` |
| Пространство `CONFLUENCE_TARGET_SPACE` существует и доступно | `space_not_found` |
| Родитель `CONFLUENCE_PARENT_PAGE_ID` существует и лежит в этом пространстве | `parent_not_found` |
| Рендерер не нашёл небезопасных ссылок | `unsafe_link` |
| Страница привязки существует, принадлежит документу (метка), не перенесена в другое пространство, не изменена вручную; без привязки — заголовок не занят чужой страницей | `mapped_page_missing`, `foreign_page`, `page_moved`, `manual_edit`, `title_taken` (`docs/CONFLUENCE_MAPPING.md`) |

Пространство и родитель берутся **только из конфигурации**. Ни один маршрут не принимает page ID, space или URL,
у маршрутов публикации нет тела запроса; поле `confluence_page_id` во frontmatter игнорируется (предупреждение
`frontmatter_page_id_ignored`). Запись дополнительно требует `write_enabled` (раздел 0 документа готовности).

Проблемы с действием `conflict` переводят задание в `conflict`, остальные — в `failed`.

## 5. Dry-run — только чтение

Dry-run выполняется при `prepare`, явным `POST …/dry-run`, при сверке и после подтверждения ручной правки.
Он выполняет **только запросы чтения** — никаких служебных записей, в том числе меток:

- GitLab: ревизия файла в ветке знаний, `commits/:sha/merge_requests` (при необходимости — синхронизация базы знаний);
- Confluence: `GET /rest/api/space/:key`, `GET /rest/api/content/:parent`, страница привязки
  (`GET /rest/api/content/:id`) или поиск по заголовку (`GET /rest/api/content?spaceKey&title&type=page`),
  метка (`GET /rest/api/content/:id/property/skh-managed-document`).

Результат (`PublicationPlan`) сохраняется в задании:

| Поле | Содержание |
|---|---|
| `action` | `create`, `update`, `noop`, `conflict` |
| `revision` | ревизия GitLab, которая будет опубликована |
| `target` | `space_key`, `parent_id`, `page_id` (если страница найдена), `title`, `url` |
| `storage` | точный storage-текст, который будет записан |
| `diff`, `diff_kind` | unified diff: `new_page` (пусто → новая страница), `page_update` (текущая страница → новая ревизия), `manual_edit` (опубликовано приложением → текущее в Confluence), `none` |
| `warnings`, `problems` | предупреждения и блокирующие проблемы (код, сообщение) |
| `remote_version` | текущая версия страницы в Confluence |
| `rendered_hash` | подпись отрендеренного storage |
| `merge_request` | доказательство merge: `iid`, `url`, `merged_at` |
| `checked_at` | время проверки |

Если запись выключена (`dry_run_only`), UI и API показывают только предпросмотр; `publish` → `503 publish_disabled`.

## 6. Публикация (явное действие)

`POST /api/publications/jobs/{id}/publish` — только из `dry_run_ready` и только при `write_enabled`:

1. Под блокировкой документа заново строится план (те же чтения). Если появились проблемы или изменились
   `(action, remote_version, rendered_hash)`, запись не выполняется: план обновляется, ответ `409 plan_changed`
   с `details.state` — человек смотрит новый предпросмотр.
2. Атомарный переход `dry_run_ready → publishing` (второй параллельный запрос получает `409`).
3. Действие:
   - `create`: `POST /rest/api/content` с метаданными `metadata.properties.skh-managed-document`; затем чтение
     метки; если её нет — отдельный `POST …/property`;
   - `update`: `PUT /rest/api/content/:id` с `version.number = remote_version + 1`;
   - `noop`: запросов записи нет; привязка получает текущую ревизию, версия страницы не меняется.
4. Страница перечитывается; привязка сохраняется (ID, версия, подпись прочитанного storage, ревизия);
   задание → `published`.

Обработка ошибок записи (POST/PUT никогда не повторяются автоматически):

| Ситуация | Результат |
|---|---|
| `409` от Confluence | `conflict`: «Страница изменилась в Confluence во время публикации. Ничего не перезаписано» |
| `401`, `403`, `400`, `404` (результат определён) | `failed` с понятным сообщением; можно повторить после устранения причины |
| Таймаут, обрыв, `5xx`, некорректный ответ после записи | проверка Confluence только чтением: создание — поиск по заголовку **и** метке; обновление — версия `remote_version+1` с ожидаемой подписью. Применено → `published` (событие `write_confirmed_after_lost_answer`); не применено → `failed` («публикацию можно повторить»); не удалось выяснить → `result_unknown` |
| Непредвиденное исключение | `result_unknown` (задание никогда не остаётся в `publishing`) |

HTTP-ответ на `publish` при ошибках записи — `200` с заданием в итоговом состоянии. Ошибки HTTP `409`, `502`,
`503` означают, что запись не начиналась (задание остаётся в прежнем состоянии или получает обновлённый план);
`500` — непредвиденная ошибка во время записи, задание переведено в `result_unknown`.

## 7. Конвертация Markdown → storage format

Тот же парсер markdown-it, что и для отображения в приложении (`html=False`: сырой HTML не пропускается).

| Markdown | Storage |
|---|---|
| Заголовки `#`…`######` | `<h1>`…`<h6>`; первый `# ` с текстом, равным названию, пропускается (его показывает заголовок страницы) |
| Абзацы, мягкий/жёсткий перенос | `<p>`, перевод строки / `<br />` |
| **Жирный**, *курсив*, ~~зачёркнутый~~, `код` | `<strong>`, `<em>`, `<del>`, `<code>` |
| Списки | `<ul>`/`<ol>`/`<li>` |
| Цитаты | `<blockquote>` |
| Таблицы | `<table><tbody>` с `<th>`/`<td>` |
| Ссылки `http(s)://`, `mailto:` | `<a href="…">` (атрибут экранирован) |
| Блоки кода | макрос `<ac:structured-macro ac:name="code">` с параметром `language` (если имя языка безопасно) и `CDATA` (последовательность `]]>` внутри кода разбивается) |
| Горизонтальная линия | `<hr />` |

В начало страницы добавляется панель-макрос `info`: документ, статус, владелец и предупреждение, что
правки вносятся через GitLab MR, а ручная правка будет обнаружена как конфликт. Весь текст и атрибуты
экранируются.

| Конструкция | Уровень | Код | Что на странице |
|---|---|---|---|
| Ссылки `javascript:`, `data:`, `file:`, `vbscript:` | **ошибка** (публикация запрещена) | `unsafe_link` | — |
| Изображения | предупреждение | `image_not_published` | `[Изображение не опубликовано: <подпись>]` |
| HTML-разметка | предупреждение | `raw_html_as_text` | экранированный текст |
| Диаграммы `mermaid`, `plantuml`, `puml`, `dot`, `graphviz` | предупреждение | `diagram_as_code` | исходный код в макросе `code` |
| Ссылки на документы базы (`<ID>.md`) | предупреждение | `internal_link_as_text` | текст ссылки без `href` |
| Прочие ссылки (относительные, не http(s)/mailto) | предупреждение | `link_as_text` | текст ссылки без `href` |
| Нумерованный список не с 1 | предупреждение | `list_start_ignored` | нумерация с 1 |

Ничего не теряется молча: каждая неподдерживаемая конструкция видна в dry-run до публикации.

`storage_signature` — SHA-256 storage после удаления пробелов между тегами и нормализации `<br>`. Используется
для сравнения содержимого страниц (Confluence пересериализует XHTML). Насколько этого достаточно для реального
DC — пункт live validation.

## 8. Исполнение: синхронно, с durable-состоянием

- Отдельной очереди, Redis, Celery и фонового воркера нет (ADR-035). Dry-run и публикация выполняются
  синхронно в запросе API; всё состояние — в SQLite `PUBLICATION_STATE_PATH` (по умолчанию
  `workspace/publications.sqlite3`, в Docker — том `workspace`).
- Одно активное задание на документ: частичный уникальный индекс `one_active_job_per_document`
  (`pending`, `validating`, `dry_run_ready`, `publishing`, `result_unknown`), блокировка документа внутри
  процесса и атомарные переходы состояний (compare-and-set). `prepare` при активной записи или
  `result_unknown` → `409 publication_in_progress`.
- Восстановление при старте (`PublicationService.recover`): прерванный dry-run (`validating`) → `pending`;
  прерванная запись (`publishing`) → `result_unknown` с кодом `interrupted` — перед повтором Confluence
  проверяется.
- Расчёт на один процесс backend (PB-11); блокировка внутри процесса не защищает несколько реплик, атомарные
  переходы в SQLite — защищают от двойной записи.

## 9. Независимость от GitLab MR

- Публикация не меняет GitLab, предложение и базу знаний. Ошибка Confluence не откатывает merge
  (проверено тестами E2E-29/30).
- Задание создаётся автоматически только после подтверждённого merge **и** успешной синхронизации
  (`on_document_merged`, с `proposal_id`) — и сразу выполняет dry-run. Автоматической публикации нет.
- Задание можно подготовить и вручную (`POST /api/documents/{id}/publication/prepare`) для текущей ревизии;
  без доказательства merge оно завершится `failed`/`not_merged`.
- Новая ревизия документа заменяет активное задание старой ревизии (`superseded`); задания в `failed`
  и `conflict` остаются в истории.

## 10. Журнал событий

`publication_events` хранит без содержимого: время, исполнителя, действие, задание, документ, ревизию,
состояние. Действия: `job_created`, `dry_run`, `superseded`, `plan_changed`, `publish_started`,
`published_create`, `published_update`, `published_noop`, `publish_failed`, `conflict`, `result_unknown`,
`write_confirmed_after_lost_answer`, `write_confirmed_on_check`, `manual_edit_acknowledged`. События видны в
`history` задания. Требования к хранению и выгрузке — PB-15.

## 11. Где проверено

- `backend/tests/test_confluence_storage.py` — конвертация, экранирование, ошибки/предупреждения, подпись (E2E-35).
- `backend/tests/test_publications.py` — задание после merge, dry-run без записи, создание, обновление, noop,
  ручная правка, 401/403, недоступность, потерянный ответ, `result_unknown`, перезапуск, немёрженная ревизия,
  статус, выключенная запись, чужие страницы, `confluence_page_id`, отсутствие page ID в API, один активный
  job, метки статусов, токен не попадает в журналы и ответы (E2E-23…34, 36).
- `backend/tests/test_integration_profiles.py` — запись только в mock/staging (E2E-34 на уровне конфигурации).
- `make mock-e2e` — сквозной сценарий в Docker на тестовых дублях.
- Vitest `frontend/src/__tests__/publication.test.tsx` — блок публикации на странице документа и страница
  задания `/publications/<id>` (кнопки скрыты/заблокированы при выключенной записи, подтверждение ручной
  правки, «Проверить результат», `409 plan_changed`).
- Playwright `frontend/e2e/publication.spec.ts` (`@gitlab`) — E2E-23…28, 31, 33, 36 в браузере на стеке с
  тестовыми дублями.
