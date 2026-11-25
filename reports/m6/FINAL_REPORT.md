# M6 — итоговый отчёт: собственный Work Management в SKH (шаги 0–6)

Дата: 25.11.2026. Ветка `feature/m6-native-work-management` (git worktree `semantic-knowledge-hub-m6`), основание —
`main` `77c753a` (совпадает с проверенным GitHub baseline `77c753a3`). Ничего не отправлено (push), не слито (merge) и
не развёрнуто: шаг 7 (развёртывание) в это задание не входил. Метки статуса: **implemented**, **tested**,
**not implemented**, **not verified**, **external blocker**.

**Итог одной фразой.** Функциональный P0 M6 для **одного локального оператора** реализован и проверен (код готов к
локальной демонстрации). **Не «готов к команде»**: настоящей идентификации пользователей и проверенного RBAC участников
проекта в общем окружении нет (external blocker), производительность под параллельной нагрузкой на проекте в 1000
задач не достигает цели (P1).

## 1. Коммиты

| SHA | Шаг | Содержание |
|---|---|---|
| `abc7a32` | 0 | аудит исходного состояния, `.tasks/` в `.gitignore` |
| `8cb73ec` | 1 | ядро: `work.sqlite3`, миграции, проекты/задачи, шлюз идентичности, аудит, посев |
| `9a2081d` | 2 | планирование: FS DAG, Гант-снимок, предпросмотр и атомарное применение |
| `b95d597` | 2 | типизированный клиент API для UI |
| `fba61c8` | 2 | документация шагов 1–2 |
| `94d5d24` … `5dcf9a2` | 3 | UI: Проекты, Список, Доска, Гант, карточка задачи, E2E, документация UI |
| `15ee820` | 4 | связи задач с документами (ревизии по снимку читателя, обратные ссылки, фильтр) |
| `f10aa10` | 5 | `work_inspect` (read-only инструмент M5.7) и типизированные AI-предложения плана |
| _этот коммит_ | 6 | `make work-eval`, тесты сценариев, документация, отчёт |

## 2. Новые API, миграции, страницы

**Миграции** `work.sqlite3` (аддитивные, бэкап перед миграцией, проверка копии по её версии):
v1 `work_core` (шаги 1–2), **v2 `task_document_links`** (индекс связей по проекту, частичный уникальный индекс одной
активной связи), **v3 `work_ai_proposals`** (предложения плана).

**Маршруты шагов 4–5** (полный контракт — `docs/API_CONTRACTS.md` v0.8):

| Маршрут | Действие |
|---|---|
| `GET /api/tasks/{id}/links` | `view_tasks` |
| `POST /api/tasks/{id}/links` | `edit_task` |
| `DELETE /api/tasks/{id}/links/{link_id}` | `edit_task` |
| `POST /api/tasks/{id}/links/{link_id}/acknowledge` | `edit_task` |
| `GET /api/projects/{id}/documents` | `view_tasks` |
| `GET /api/documents/{id}/tasks` | `view_tasks` (+ `read_knowledge`) |
| `GET /api/projects/{id}/tasks?document=ID` | `view_tasks` (новый фильтр) |
| `POST /api/work-ai/proposals` | `propose_work` |
| `GET /api/work-ai/proposals/{id}` | `propose_work` |
| `POST /api/work-ai/proposals/{id}/preview` | `propose_work` |
| `POST /api/work-ai/proposals/{id}/apply` | `apply_work_proposal` |
| `POST /api/work-ai/proposals/{id}/reject` | `propose_work` |

Новые коды ошибок: `knowledge_unavailable` (503), `proposal_invalid` (422), `proposal_stale` (409). `TaskOut`:
`link_count` (теперь `null`, если базу знаний не проверить) и `document_ids`. `features.document_links = true`,
`features.ai_proposals` — по возможности провайдера. Инструмент M5.7 `work_inspect`; системные факты `skh_work`.

**UI**: «Документы» в карточке задачи (связать / проверено / убрать, состояния), «Задачи» на вкладке «Связи»
документа, фильтр «Документ» в Списке/Доске/Ганте, кнопка «AI план» и проверка предложения (`?proposal=WAP-…`),
карточки фактов «По данным модуля «Работа» SKH» в ответах ассистента. Руководство — `docs/WORK_USER_GUIDE.md`.

## 3. Планирование и границы MVP

`[start_date, end_exclusive)`, Пн–Пт без праздников, `due_date` включительно и отдельно от плана; FS с лагом 0 в одном
проекте, DAG без циклов; задачи без дат допустимы и не получают придуманных дат; закреплённые сроки дают конфликт;
предпросмотр ничего не пишет, применение — одна транзакция с `plan_revision`, `409 stale_schedule` и идемпотентным
повтором (подробно — `docs/WORK_MANAGEMENT.md` §2–§3). Не входит в P0: CPM/критический путь (не показывается вместо
ложного), SS/FF/SF, лаг ≠ 0, праздники, ресурсное выравнивание, комментарии.

## 4. Повторное использование и новые адаптеры

- **Знания** — существующий `KnowledgeService.snapshot(user)` (граница доступа — репозиторий): связи хранят только id
  и ревизию при связывании, всё остальное читается при каждом запросе. Новое: `app/work/links.py` (`DocumentScope`,
  состояния связи), разрешение снимка один раз на запрос в `app/api/work.py`. Параллельного хранилища документов нет;
  связи не становятся рёбрами графа знаний и не пишут документы. Поиск документа для связи — существующий
  `/api/links/suggest`. Посев связей — из снимка оператора при старте (`seed_demo_links`).
- **M5.7** — тот же `ToolLoop`/`SystemToolExecutor`, протокол и лимиты; добавлен один read-only `work_inspect`
  (`app/work/inspect.py`). Политика ассистента `TOOL_POLICY` v4 (минимальная правка: иначе она утверждала, что
  задач нет).
- **AIProvider** — необязательная возможность `plan_work` по модельно-независимому JSON-протоколу
  (`app/adapters/ai/work_protocol.py`) по образцу Template Studio: реализована в `openai_compatible` и `claude_cli`;
  у `mock` и `disabled` её нет. GigaChat-адаптер не создавался (его нет; `internal_api` остаётся нейтральной точкой).
- **Цитаты** — существующие `prepare_passage_text` и `quote_is_verbatim`; доступ — `AuthorizationPolicy` + шлюз
  проекта `WorkAccessGate`.

## 5. Где применён AIProvider и как исключена запись без подтверждения

1. Чат: модель только **читает** через `work_inspect`; инструмента записи в цикле нет.
2. «AI план»: модель возвращает текст; сервер разбирает, проверяет и **сохраняет предложение**, задачи не меняются
   (M6-13: тест сравнивает число задач, зависимостей, связей, ревизию плана и аудит до и после).
3. Запись — только `POST …/apply` от человека: проверка шлюза `apply_work_proposal`, своё предложение в статусе
   `suggested`, совпадение `expected_plan_revision`, срока и ревизий/видимости всех источников (иначе
   `409 proposal_stale`), затем одна транзакция с идемпотентным ключом; ошибка в середине откатывает всё (M6-18).
4. Шлюз `propose_work` проверяется **до** вызова модели: в режиме только для просмотра, у viewer и не участника модель
   не вызывается (тест проверяет пустой журнал вызовов двойника).
5. Исполнители, даты и id от модели отбрасываются; даты считает сервер; источник вне переданных документов и
   недословная цитата не попадают в данные.

## 6. Проверки (команды и фактические результаты)

| Команда | До (начало шагов 4–6) | После |
|---|---|---|
| `make check` → ruff, ruff format, mypy strict | чисто | чисто: `All checks passed!`, `234 files already formatted`, `Success: no issues found in 141 source files` |
| `make check` → pytest | **983 passed, 6 skipped** | **1029 passed, 6 skipped** (6 skipped — live-тесты, только явно) |
| `make check` → tsc, eslint | чисто | чисто |
| `make check` → vitest | **51 files, 619 passed** | **53 files, 634 passed** |
| Playwright `desktop` + `mobile` (стенды mock 5185, disabled 5186, read-only 5189; `E2E_SKIP_GITLAB_STACK=1`) | шаг 3: 84 passed, 1 skipped | **86 passed, 1 skipped** (пропуск прежний: на стенде mock не настроен Confluence) |
| Playwright `scripted` + `scripted-mobile` (двойник модели, `internal_api`) | — | **21 passed** |
| то же через `claude_cli` | — | **21 passed** |
| `make work-eval` (новый) | — | **17 cases, 17 pass, 0 fail** |
| `make knowledge-eval` | 216 cases, 207 pass, 9 fail; R@1 0.9487, R@5 0.9744, MRR 0.9647, leaks 0 | **то же**: 216 / 207 / 9, R@1 0.9487, R@5 0.9744, MRR 0.9647, leaks 0; тот же `cases_hash` и `kb_snapshot_hash`, те же 9 непройденных случаев |
| `make mock-kb-validate` | — (фикстуры не менялись) | `RESULT: OK` |

Проект `gitlab-mock` Playwright **не запускался** (он поднимает собственные порты 8011/5175/8929–8931, вне разрешённых
для этой работы) — **not verified** здесь; код интеграций GitLab/Confluence шаги 4–6 не меняли.

**Проверка чувствительности тестов (мутации, временные правки, откатываются):** скрытый документ показан как
актуальный → убит; счётчик ссылок учитывает скрытые документы → убит; история не редактируется → убит; не проверяется
цикл плана → убит; выдуманный источник сохраняется → убит; не проверяются источники при применении → убит;
`work_inspect` предлагается всегда → убит; исполнитель от модели сохраняется → убит; убрана одна из двух проверок
ревизии плана при применении → выжил (двойная защита намеренно), обе → убит.

### 6.1 Финальные прогоны (25.11.2026, после всех правок шагов 4–6)

- `make check` → exit 0: ruff, format, mypy strict — без замечаний; pytest `1029 passed, 6 skipped in 68.86s`;
  tsc, eslint — без замечаний; vitest `Test Files 53 passed (53)`, `Tests 634 passed (634)`.
- Playwright `desktop` + `mobile` на свежих стендах: `86 passed, 1 skipped (1.9m)`. Первая попытка на стенде mock,
  который уже прошёл один полный прогон, дала 5 падений `graph.spec.ts` (ожидание «Схема графа: 97 узлов»): шаблоны,
  созданные тестами Template Studio в прошлом прогоне, добавили узлы (100 вместо 97). На перезапущенном стенде — зелёно;
  это состояние стенда, не регрессия (тесты графа предполагают свежий стенд).
- Playwright `scripted` + `scripted-mobile`: `21 passed` через `internal_api` и `21 passed` через `claude_cli`
  (двойник модели на 8024, backend 8021, Vite 5186). Это не свидетельство о реальной модели.
- `make work-eval`: `[work-eval] cases=17 pass=17 fail=0`; отчёт `reports/m6/work-eval/work-eval.json`.
- `make knowledge-eval`: `[after] cases=216 pass=207 fail=9 error=0 unsupported=0 R@1=0.9487 R@5=0.9744 MRR=0.9647
  leaks=0` — совпадает с «до». Отслеживаемые файлы `reports/knowledge-eval/after*` (старый прогон 23.11 на 200 случаях)
  не перезаписывались в этом коммите, чтобы не смешивать несвязанные изменения; свежий вывод сохранён вне репозитория.
- `make mock-kb-validate`: `RESULT: OK` (фикстуры базы знаний не менялись).
- Все запущенные локальные стенды (8020/8021/8024, 5185/5186/5189) и двойник модели остановлены.

## 7. Сценарии M6-01…40

| ID | Статус | Где проверено |
|---|---|---|
| M6-01 | tested | API `test_m6_01_…`; E2E «M6-01 creates a project…» |
| M6-02 | tested | API `test_m6_02_…`; vitest доски; E2E «M6-02 dragging a card…» |
| M6-03 | tested | API `test_m6_03_m6_04_…`; E2E «M6-03/M6-04 Gantt drag → preview → apply» |
| M6-04 | tested | планировщик, API, E2E |
| M6-05 | tested | API `test_m6_05_…`, планировщик, work-eval `write-refusals`, vitest (путь цикла) |
| M6-06, M6-07 | tested | API `test_m6_06_m6_07_…`, work-eval |
| M6-08 | tested | API/планировщик `test_m6_08_m6_29_…` |
| M6-09 | tested | календарь, планировщик, API, work-eval `cal-fri-mon`, даты AI-плана (`test_m6_13_…`, пт → пн) |
| M6-10 | tested | API `test_m6_10_…`, vitest (ромб), work-eval |
| M6-11 | tested | `test_m6_11_link_is_read_from_the_current_snapshot_both_ways`; vitest `workLinks`; E2E «M6-11 links a task…» (обе стороны + фильтр) |
| M6-12 | tested | `test_m6_12_m6_37_hidden_document_leaks_nothing…`; work-eval `links-hidden` |
| M6-13 | tested (двойник модели) | `test_m6_13_…` (internal_api и claude_cli); E2E `workAi` |
| M6-14 | tested (двойник модели) | `test_m6_14_apply_writes…`; E2E `workAi` |
| M6-15 | tested | `test_m6_15_rejected_proposal…`; E2E `workAi` |
| M6-16 | tested | `test_m6_16_invalid_plan_is_refused…` (цикл, неизвестный id); work-eval; vitest (сообщение) |
| M6-17 | tested | API + два сервиса/потока (шаг 1); E2E (путь правки с версией) |
| M6-18 | tested | `test_m6_18_failure_in_the_middle_of_apply…` (расписание), `test_m6_18_failure_during_apply_rolls_everything_back` (AI-план) |
| M6-19 | tested (тестовая серверная идентичность) | `test_m6_19_m6_37_…`; viewer не может связывать и запускать AI-план |
| M6-20 | tested | `test_m6_20_m6_35_public_exposure_is_read_only` (вкл. связи и AI-план), `test_m6_20_public_exposure_never_invokes_the_model`; E2E read-only (вкл. документы задачи) |
| M6-21 | tested (перезапуск процесса); **not verified** для контейнера | `test_m6_21_data_survives_a_restart`; Docker в этой работе не запускался |
| M6-22 | tested | `test_m6_22_…`, `test_seeded_links_point_at_synthetic_documents_idempotently`, work-eval `seed-idempotent` |
| M6-23 | tested | vitest на 200 задач, замер UI шага 3 (`docs/WORK_MANAGEMENT.md` §9.4) |
| M6-24 | tested | `test_m6_24_m6_38_changed_document_is_flagged…` (изменение файла, флаг, «Проверено»); work-eval; vitest |
| M6-25 | tested | `test_m6_25_m6_40_…` (оба), `test_model_failure_or_garbage_stores_nothing`, `test_m6_25_mock_provider…`; E2E на стенде mock и disabled |
| M6-26 … M6-32 | tested | шаги 2–3 (`reports/m6/STEP1_2_BACKEND.md`), work-eval (M6-26/27/28/29/30/31/32) |
| M6-33 | tested (двойник модели) | `test_m6_33_hallucinated_assignee_dates_and_sources…`; work-eval `ai-hallucinations`; vitest (замечания) |
| M6-34 | tested | `test_m6_34_deleted_document_becomes_unavailable…`, `test_m6_34_changed_or_hidden_source…` (предложение устарело) |
| M6-35 | tested | `test_m6_35_no_client_can_claim…`, `test_m6_20_m6_35_…`; E2E read-only |
| M6-36 | tested | API `test_m6_36_…`; E2E M6-01 (одна ревизия во всех видах) |
| M6-37 | tested (тестовая серверная идентичность); team-ready — **external blocker** | `test_m6_19_m6_37_…`, связи, `work_inspect`, AI-план (не участник — 404, модель не вызвана) |
| M6-38 | tested (смена версии шаблона имитируется правкой метаданных документа; сама Template Studio не запускалась) | `test_m6_38_template_version_change_keeps_the_canonical_id…` |
| M6-39 | tested (двойник модели) | `test_m6_39_…` (предлагается только при правах, схема без субъекта и записи), `test_overdue_tasks_come_from_the_work_module…` (оба транспорта), ACL `test_m6_37_m6_39_…`; E2E `workAi` |
| M6-40 | tested | `test_m6_25_m6_40_…`, `test_m6_40_unreadable_knowledge_never_blocks_tasks…`, `test_m6_40_without_the_work_module…` |

## 8. Производительность (измерено, не обещано)

macOS 26.5.2 arm64, Python 3.12.15, локальный стек (`python -m app`, один процесс uvicorn), loopback, синтетические
проекты. Уровень сервиса `work_bench` p95: 200 задач — список 2,6 мс, Гант 3,4, правка 1,7; 1000 — 11,8 / 22,2 / 5,3;
3000 — 39 / 56 / 19. HTTP, 1 клиент, p95: 1000 задач — список 200 строк 22 мс, Гант 26 мс, PATCH 3,9 мс. HTTP,
10 клиентов без пауз: 200 задач — список p95 381 мс, Гант 380 мс, GET+PATCH 141 мс (**цель 05 §5 выполнена**);
1000 задач — список 1,8 с, Гант 1,9 с (**цель не выполнена**), GET+PATCH 275 мс. Причина измерена: CPU-тяжёлые
синхронные обработчики в одном процессе конкурируют за GIL (Гант 200 задач: 241 → 49 запросов/с при 10 клиентах); на
коде шага 3 — так же (29 запросов/с), то есть шаги 4–5 не ухудшили (≈ +0,3 мс на запрос). Это dev-стенд, не staging.

## 9. Скриншоты (реальный браузер, Chrome, не в репозитории)

`/private/tmp/claude-501/-Users-arturtaim-GitHub-semantic-knowledge-hub/0d685b51-50ad-4915-880f-571fd893dc96/scratchpad/m6/stage3/shots/`:
`list-*`, `board-*`, `gantt-*`, `list-doc-filter-*`, `task-documents-*`, `document-tasks-*`, `ai-proposal-review-*` ×
`light|dark` × `1440|390` (28 файлов). Предложение AI снято на стенде со скриптовым двойником модели.

## 10. Отклонения от ТЗ, P1, остаточные риски

**Отклонения (осознанные):**
- Связь задачи с документом **не** создаёт рёбер в графе знаний (указание владельца: типизированные связи объявляют
  люди в YAML); «проекция рядом с графом» — раздел «Задачи» на странице документа и `GET /api/documents/{id}/tasks`.
- AI-предложения хранятся в `work.sqlite3`, а не в `AiProposalStore` (`app_state.sqlite3`): иначе применение (задачи +
  статус предложения) не было бы одной транзакцией. Контракт тот же: предложение с доказательствами, явное принятие,
  недействительно при смене основания. Статус `stale` вычисляется при чтении; `accepted` совмещён с `applied`.
- Типы предложений: реализован `task_plan` (требования → задачи и график). Сводка статуса/рисков — через чат и
  `work_inspect` по фактам (без отдельной сущности); предложение переноса сроков — P1 (у людей есть предпросмотр).
- Создание плана — только из UI проекта; инструмента создания предложения в цикле чата нет (ТЗ допускает, но не
  требует; меньше поверхности для записи).
- `make work-ai-smoke` (живая модель) **not implemented**: живые модели в этой работе запрещены.

**P1:** несколько процессов uvicorn / кэш производных полей (производительность под нагрузкой); внешние ссылки задач
на Confluence/GitLab; CPM; комментарии; лаг и типы зависимостей; ограничение частоты запросов на AI-маршрутах;
предложение переноса сроков; управление участниками проекта после появления каталога пользователей.

**Остаточные риски:** идентичность — `LocalDemoPolicy` (один оператор), режим участников проверен только тестовой
серверной идентичностью — **external blocker** для командного режима; качество планов от реальной модели (GigaChat
или иной) **not verified** — только скриптовый двойник; производительность чтения больших проектов под параллельной
нагрузкой — ниже цели; публичный стенд получит новый режим лишь после повторного развёртывания (шаг 7, не
выполнялся).

**Решения владельца после отчёта (2026-11-25):** один пользователь на демо-стенде допустим; исполнители — вымышленная
демо-команда из шести человек (3 аналитика, руководитель проекта, 2 разработчика) как пример распределения задач;
на демо-стенде за логином разрешена запись одному общему суперпользователю — режим `shared_login`
(`WORK_SHARED_LOGIN_WRITES=true`), отклонение от спецификации описано в `docs/WORK_MANAGEMENT.md` §4.

## 11. Откат

Код: ветка не слита — откат = не сливать / `git revert` нужных коммитов. Данные: миграции аддитивны; перед миграцией
существующей базы создаётся `work.sqlite3.pre-v<N>-<UTC>.bak`; откат — остановить backend →
`python -m app.tools.work_db restore --from FILE --yes` → запустить предыдущую версию (`docs/WORK_MANAGEMENT.md` §5).
Копия проверяется по её собственной версии схемы (тест на реальной базе v1 → v3).
