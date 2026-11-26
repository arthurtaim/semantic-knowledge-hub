# 00 — Исходное состояние и разбор находок (Post-M6 Functional Remediation)

Задание: `SKH_Post_M6_Functional_Remediation_Task.md` (25.11.2026). Ветка `fix/skh-post-m6-functional-remediation`.
Изменения не отправлялись на сервер, не сливались и не развёртывались.

## 1. Исходное состояние

| Что | Значение |
|---|---|
| Исходный HEAD | `96f133c31e304c208bd21779abb8e17e858b6eb0` (`main`: слияние `feature/planner-v2`) |
| Аудит проверял | `1377ee68bd27ed405e068a4712364632c7c1990d` (сразу после слияния M6) |
| Изменилось после аудита | 15 коммитов, только Planner v2 и только фронтенд: `git diff --stat 1377ee6 96f133c -- backend` пустой. Поэтому все бэкенд-находки на текущем HEAD воспроизводятся как есть. Исправлений, случайно сделанных в `main`, не нашлось |
| Planner | v2 (зумы Ганта, рамка проекта, фильтры в одну строку, решения владельца §7.4–7.7) |
| `git status` | чисто, кроме неотслеживаемых папок владельца (`m6 copy/`, `Claude outputs/`, `planner-v2-handoff/`); они не трогались |
| Среда | macOS (Apple Silicon), Python 3.12.15, SQLite 3.54.1, Node v26.13.0, React ^19.1, react-router-dom ^7.9 (установлен 7.18.6), Vite ^7.3, Playwright 1.58.2 (`channel: chrome`) |
| Схема Work DB | v3 (`app/work/migrations.py` `LATEST_VERSION = 3`); миграций в этой ветке нет |
| Флаги по умолчанию (`config.py`) | `AUTH_MODE=local_demo`, `AI_PROVIDER=mock`, `TASK_SYSTEM=native`, `WORK_PUBLIC_EXPOSURE=false`, `WORK_SHARED_LOGIN_WRITES=false`, `WORK_WRITES_ENABLED=true` |
| Данные | только синтетические фикстуры и изолированные тестовые базы (`tmp_path`, отдельные стенды в scratchpad). Локальная демо-база и тома сервера не трогались |

**Прочитано:**
- `README.md`, `AGENTS.md`, `CLAUDE.md`;
- `docs/WORK_MANAGEMENT.md`, `docs/TEMPLATE_HUB.md`, `docs/API_CONTRACTS.md`, `docs/KNOWLEDGE_GRAPH.md`, `docs/DOCUMENT_CREATION_WORKFLOW.md`;
- полные отчёты обоих аудиторов: `skh-audit-a-results/02_FINDINGS.md` + `findings.csv` + `raw_logs/test_probes_a.py`, `skh-audit-b-results/04_DEFECTS.md` + `defects.csv` + `05_STRESS_RESULTS.md`, сводка.

Полные отчёты были доступны, поэтому ниже разобраны все 29 находок, а не только перечисленные в ТЗ.

## 2. Разбор находок

Обозначения:
- **Воспроизведено на HEAD:**
  - **RED** — новый регрессионный тест упал на исходном коде именно из-за дефекта;
  - **CODE** — подтверждено чтением неизменённого кода.
- **Решение:**
  - **FIXED** — исправлено и защищено тестом;
  - **DOC** — устранён дефект документации, поведение не меняется;
  - **DEFERRED_BY_OWNER_DEMO_SCOPE** — исключено решением владельца;
  - **OPEN** — остаётся, причина указана.

| audit_id | Исх. | Код | На HEAD | Ожидалось | Фактически | Тест | Решение |
|---|---|---|---|---|---|---|---|
| CODE-001 | P1 | `authz.py` `LocalDemoPolicy`, шлюз | CODE | за публичным шлюзом только чтение везде | только чтение действует лишь в «Работе» | — | DEFERRED_BY_OWNER_DEMO_SCOPE (глобальный read-only, права демо-оператора) |
| SYS-004 | P1 | то же | CODE | то же | то же | — | DEFERRED_BY_OWNER_DEMO_SCOPE (дубль CODE-001) |
| CODE-002 | P2 | `work/service.py` `restore_task` | RED | у вехи нет подзадач | восстановление давало вехе подзадачу | `test_work_restore.py` | FIXED (A1) |
| CODE-003 | P2 | `restore_task`, `_validate_parent` | RED | не больше 4 уровней | после восстановления глубина 6 | `test_work_restore.py` | FIXED (A1) |
| CODE-004 | P2 | `adapters/ai/work_protocol.py` | RED | управляемая ошибка AI | 500 `KeyError: slice` | `test_work_ai_robustness.py` | FIXED (A2) |
| CODE-005 | P2 | `work/ai.py`, `service.apply_task_plan` | RED | даты 2000–2100, ошибка 422 | 9999 → 500, 2999 → записывалось | `test_work_ai_robustness.py` | FIXED (A3) |
| CODE-006 | P2 | `Caddyfile.login`, `permissions.py` | CODE | пароль не уходит по HTTP | Basic Auth по HTTP на IP | — | DEFERRED_BY_OWNER_DEMO_SCOPE (Caddy, HTTP/HTTPS, вход) |
| SYS-002 | P2 | `services/template_studio.py` `_prefixes` | RED | чужой черновик не мешает владельцу | активация владельца → 422 `id_prefix_taken` | `test_template_prefix_ownership.py` | FIXED (A4) |
| SYS-006 | P2 | `errors.py`, `work/db.py` | RED | управляемый временный сбой | 500 с трассировкой, обрыв keep-alive | `test_storage_busy.py` | FIXED (A5) |
| SYS-007 | P2 | `DocumentEditor.tsx` | RED (vitest: 5 из 6 упали до исправления) | подтверждение перед уходом | правки терялись молча | `leaveGuard.test.tsx`, `leaveGuardProgrammatic.test.tsx`, e2e `blankDocument` B-07 | FIXED (B1) |
| SYS-009 | P2 | планировщик, бэкенд | замер | цели p95 (чтение < 500, запись < 800 мс) | 1000 × 10 клиентов: p95 PATCH 3652, preview 3073 мс; 200 × 10: 807 / 1010 мс | нагрузочные прогоны до/после, `test_work_perf_equivalence.py` | FIXED (D): цели выполнены на всех уровнях 25/200/1000 × 1/3/10, см. `03_PERFORMANCE.md` |
| CODE-007 | P3 | `service.capabilities` | CODE | `can_write`/`can_view_audit` по роли | в режиме membership не зависят от роли | — | DEFERRED_BY_OWNER_DEMO_SCOPE: только командный режим membership (`team_ready=false`, в демо не используется), это многопользовательский RBAC. В демо-режимах флаги верны |
| CODE-008 | P3 | `work_protocol.py` `local_id` | RED | правки и исключение задач работают | «т1», «t 1» сохранялись и не редактировались | `test_work_ai_robustness.py` | FIXED (A2): такой ответ → `502 ai_invalid_response` |
| CODE-009 | P3 | `middleware.py` `X-Request-ID` | CODE | серверный correlation id | клиентский попадал в аудит | — | DEFERRED_BY_OWNER_DEMO_SCOPE (целостность аудита против подделки клиентом — security hardening) |
| CODE-010 | P3 | `resolve_interval` (веха) | CODE | неясно: правило канонизации в §2 описано для интервалов | веха хранится на выходном | — | DOC: правило записано явно (веха — точка на выбранной дате, последователь по FS — не раньше следующего рабочего дня). Сдвигать дату человека молча = менять смысл дат, что ТЗ запрещает |
| CODE-011 | P3 | `resolve_interval` | RED | вычисленный конец ≤ 2100, как явный | 2100-12-30 + 2000 р.д. → 2108 | `test_work_ai_robustness.py` | FIXED (A3) |
| CODE-012 | P3 | `_validate_parent` | RED | родителя можно указать ключом | `PKY-1` → 422 | `test_work_p3_remediation.py` | FIXED |
| CODE-013 | P3 | `knowledge_eval.py`, отчёт | RED | провал → ненулевой код выхода | rc=0 при 9 провалах; отчёт на 200 кейсов | `test_knowledge_eval_exit.py` | FIXED (C1); 9 кейсов остаются, см. `02_TEST_RESULTS.md` |
| CODE-014 | P3 | `work/store.py` | RED | таблицы не растут бесконечно | `work_idempotency` и применённые предпросмотры не чистились | `test_work_p3_remediation.py` | FIXED (срок 7 дней; аудит не удаляется) |
| CODE-015 | P3 | `list_projects`, аудит задачи | замер (cProfile, `EXPLAIN`) | счётчики без построения всех задач; история по индексам задачи | 5 × 1000 задач → 48 мс; история растёт с аудитом проекта | `test_work_perf_equivalence.py` | FIXED (D): 48 → 3,2 мс; история 6,0 → 0,8 мс |
| CODE-016 | P3 | `work/db.py` права файлов | CODE | — | 0644 | — | DEFERRED_BY_OWNER_DEMO_SCOPE (права файлов, security) |
| CODE-017 | P3 | маршруты с моделью | CODE | — | нет ограничения частоты | — | DEFERRED_BY_OWNER_DEMO_SCOPE (rate limiting) |
| SYS-001 | P3 | `api/graph.py` `/path` | RED | неизвестный узел → 404/422 | 200 `found:false` | `test_sync_and_graph.py` | FIXED |
| SYS-003 | P3 | `apply_schedule` | RED | пустой apply не меняет ревизию | `plan_revision` +1 без аудита | `test_work_p3_remediation.py` | FIXED |
| SYS-005 | P3 | импорт: предпросмотр и создание | RED | превышение видно в предпросмотре | лимит в символах; черновик 600 КБ создавался | `test_metadata_pipeline.py` | FIXED |
| SYS-008 | P3 | ответ ассистента | CODE | внешние ссылки модели помечены | кликабельны без пометки | — | DEFERRED_BY_OWNER_DEMO_SCOPE (защита от фишинга и инъекций — security hardening) |
| SYS-010 | P3 | Доска | замер (Playwright, Long Tasks, Event Timing) | Доска на 1000 карточек без долгих задач | 46 196 узлов DOM, long task 354 мс, перенос 182 мс | `workBoardWindow.test.tsx` | FIXED (D): окно по 40 карточек; 7 740 узлов, 78 мс, 27 мс |
| SYS-011 | P3 | `InlineEdit.tsx` | RED | «4 дек. Изменить» | «4 дек.. Изменить» | `inlineDateLabel.test.tsx` | FIXED |
| SYS-012 | P3 | `fixtures/knowledge/SEM-*.md` | RED (валидатор: 9 файлов) | `synthetic: true` у каждой фикстуры | у 9 SEM-* метки нет | `test_knowledge_base.py`, `test_repo_hygiene.py` | FIXED (C2) |

**Итог — всего 29 находок:**
- исправлено и закрыто тестами — 20, из них 3 по производительности (SYS-009, SYS-010, CODE-015, подробности в `03_PERFORMANCE.md`);
- закрыто уточнением документации — 1 (CODE-010);
- отложено по решению владельца — 8: CODE-001, SYS-004, CODE-006, CODE-007, CODE-009, CODE-016, CODE-017, SYS-008.

Сверх аудитов при финальной регрессии найден и исправлен один дефект изоляции тестов: стенд GitLab-mock в `make e2e` писал в рабочую базу разработчика (`01_FIXES_AND_TESTS.md`, последний раздел).

## 3. Изоляция

Каждый регрессионный тест работает на своей временной базе: фикстура `client_factory` и `tmp_path`.
- Блокировка SQLite (A5) воспроизводится вторым соединением к тестовой базе.
- Модель — скриптовый httpx-двойник; живая LLM не вызывалась.
- E2E шли на изолированных локальных стендах в scratchpad: свой каталог данных и свои порты на каждый пакет.
- Агенты-исполнители работали в отдельных git worktree. Их коммиты перенесены в ветку через `cherry-pick` без конфликтов.
