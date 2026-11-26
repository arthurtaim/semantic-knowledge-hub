# 02 — Результаты проверок

Финальная регрессия шла на итоговом коде ветки `fix/skh-post-m6-functional-remediation`. Все числа ниже — из реальных прогонов
25.11.2026. Логи хранятся в scratchpad сессии, в репозиторий они не входят.

## 1. Среда

| Что | Значение |
|---|---|
| Машина | Apple Silicon (M5), macOS 26.5.2; общая рабочая машина |
| Backend | Python 3.12.15, SQLite 3.54.1 (модуль `sqlite3`), pytest, ruff, mypy strict |
| Frontend | Node v26.13.0, vitest 3.2.7, TypeScript, ESLint |
| E2E | Playwright 1.58.2, Google Chrome 158.0.8127.37 (`channel: chrome`) |
| AI | только мок-провайдер и скриптовый двойник модели на loopback (`backend/tests/support/scripted_model.py`); живая LLM не вызывалась |
| Данные | синтетические фикстуры; временные базы тестов (`tmp_path`); E2E — на изолированных стендах: у каждого свой каталог для всех файлов состояния, включая `work.sqlite3` |
| Код | `1133001` (последний коммит с кодом); `fe6af11` — состояние, на котором шёл knowledge-eval: после него менялись только скрипт стенда E2E и его тест |

## 2. Итог

| Команда | Код выхода | Результат |
|---|---|---|
| `make check` (ruff check + format, mypy strict, tsc, eslint, pytest, vitest) | **0** | ruff: All checks passed, 244 files already formatted; mypy: no issues in 142 source files; tsc, eslint: 0 ошибок; pytest: **1311 passed, 6 skipped**; vitest: **61 files, 731 passed** |
| `pytest tests/test_e2e_stack_isolation.py` (после `make check`, новый тест) | 0 | 1 passed; ruff check и format — чисто |
| `make mock-kb-validate` | **0** | `RESULT: OK` — все 83 документа, цепочки связей, `synthetic: true` у каждого |
| `make work-eval` | **0** | `cases=17 pass=17 fail=0` |
| `make knowledge-eval` | **2** (скрипт вернул 1) | `cases=216 pass=207 fail=9 error=0 unsupported=0`, R@1 0,9487, R@5 0,9744, MRR 0,9647, утечек 0 — **ожидаемо красный**, см. §4 |
| E2E, полный прогон: все проекты Playwright (`npx playwright test`) | **0** | **125 passed, 9 skipped** (2,4 мин) |
| E2E, 9 тестов, пропущенных в полном прогоне, — на стендах нужной конфигурации | **0** и **0** | **8 passed** + **1 passed** |
| Итого E2E | — | **134 passed, 0 failed**; без пропусков с учётом специальных стендов |

**6 пропусков pytest** — это live-тесты, которые включаются только явно:
- `tests/live/test_claude_cli_live.py` ×4: нужны `SKH_LIVE_TESTS=1` и `SKH_CLAUDE_LIVE_URL`, то есть личный стенд;
- `tests/live/test_live_readonly.py` ×2: нужен `SKH_LIVE_TESTS=1`.

ТЗ запрещает запускать платную живую LLM, поэтому они и не запускались.

### E2E подробно

Стенды поднимались на loopback, у каждого свой каталог для всех файлов состояния:
- основной: мок AI, Confluence выключен, `:5261`, скрипт `reports/remediation/perf_b2/stack.sh`;
- скриптовый: `AI_PROVIDER=internal_api` → скриптовый двойник модели, `:5262`;
- без AI: `AI_PROVIDER=disabled`, `:5264`;
- Work только для чтения: `WORK_WRITES_ENABLED=false`, Confluence — мок, `:5265`;
- стенд GitLab-mock: его Playwright поднимает сам через `e2e/gitlab-stack.sh`, уже с исправлением `1133001`.

Команда полного прогона:
```sh
cd frontend && E2E_BASE_URL=http://127.0.0.1:5261 E2E_SCRIPTED_URL=http://127.0.0.1:5262 npx playwright test
```

| Проект | Пройдено | Пропущено | Что внутри |
|---|---|---|---|
| desktop | 74 | 6 | M6/Planner v2 (`work.spec`: Доска и перенос карточки, Гант → предпросмотр → «Применить», клавиатура Ганта, одна ревизия плана), Template Studio, редактор и B-07 (несохранённые правки), документы, граф, каталог, ассистент |
| mobile | 17 | 3 | то же на ширине телефона, `@mobile` |
| gitlab-mock | 11 | 0 | через тестовые двойники: новый документ → MR → слияние → база знаний, конфликт ревизии, повтор без второго MR, Confluence MCP доступен и недоступен, публикация в Confluence и её конфликты |
| scripted | 17 | 0 | «План с ассистентом» (`workAi.spec`: предложение → проверка → «Создать задачи», «Отклонить»), Template Studio с AI, ответы M5.7 |
| scripted-mobile | 6 | 0 | то же на телефоне |

Пропуски полного прогона включаются только на стенде другой конфигурации, поэтому их прогнали отдельно:
```sh
E2E_SKIP_GITLAB_STACK=1 E2E_BASE_URL=http://127.0.0.1:5261 E2E_DISABLED_URL=http://127.0.0.1:5264 \
  E2E_WORK_READONLY_URL=http://127.0.0.1:5265 npx playwright test --project=desktop --project=mobile \
  e2e/assistant.spec.ts:120 e2e/blankDocument.spec.ts:226 e2e/documentAssistant.spec.ts:141 \
  e2e/templateStudio.spec.ts:232 e2e/work.spec.ts:467                       # 8 passed, exit 0
E2E_SKIP_GITLAB_STACK=1 E2E_BASE_URL=http://127.0.0.1:5265 npx playwright test --project=desktop \
  e2e/graph.spec.ts:318                                                     # 1 passed, exit 0
```
Среди них:
- M6-20/M6-35: стенд только для чтения не показывает элементов записи, API отказывает в записи;
- Template Studio без AI;
- 6 проверок интерфейса без AI (C-04/05, B-05/06, D-05/06);
- ответ с источником из Confluence.

Файл `workspace/work.sqlite3` разработчика после всех прогонов не изменился (отметка времени 19:25, до начала работ).

## 3. Не запускалось

| Что | Почему |
|---|---|
| `make up` (Docker Compose) | демон Docker на машине не запущен; запускать Docker Desktop — действие на уровне системы. Ветка не меняла `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml`, `deploy/` и зависимости; `test_container_image_paths.py` (пути состояния в образе) проходит в `make check` |
| `make knowledge-eval-live`, `make test-live` | живая LLM и стенды — запрещено ТЗ |
| GitLab, Confluence настоящие | только локальные тестовые двойники (проект `gitlab-mock` в E2E) |
| Стенд Hetzner | ветка не развёртывалась (ТЗ: без отдельного разрешения — нет) |

## 4. knowledge-eval: было и стало

| | До ветки (`96f133c`) | После |
|---|---|---|
| Кейсов в отчёте `reports/knowledge-eval/` | 200 (отчёт устарел, кейсов в `fixtures/eval` уже 216) | 216 |
| Результат | 207 / 216, 9 провалов | 207 / 216, 9 провалов — те же кейсы |
| Код выхода | **0** при 9 провалах (CODE-013) | **1** (через make — 2), строка `RESULT: FAILED — …` со списком кейсов |
| R@1 / R@5 / MRR | 0,9487 / 0,9744 / 0,9647 | те же |
| Метка `synthetic: true` | нет у 9 SEM-* (SYS-012) | у всех 83; валидатор `--strict-synthetic` проверяет каждый документ |

Исход кейсов не менялся: ветка не трогала retrieval, словарь, веса и gold-кейсы (CLAUDE.md §6). Отчёты
`reports/knowledge-eval/after*` перегенерированы на итоговом коде; по сравнению с предыдущим коммитом изменились
только задержки, время и хэш коммита. Поле `worktree_dirty: true` выставлено из-за неотслеживаемых папок владельца
и отчётов этой ветки; кода они не касаются.

### 9 непройденных кейсов

| Кейс | Holdout | Категория | Что не так (из отчёта) | Нужные факты в контексте | Причина |
|---|---|---|---|---|---|
| KE-ADR-005 | нет | synthesis | в ответе нет «Черновик (draft) никогда не авторитетен» | да | ограничение мок-провайдера: он отвечает шаблоном и не пересказывает всё найденное |
| KE-SRC-013 | нет | synthesis | нет `DQ-COMP-001`, «24 ч» | да | ограничение мок-провайдера |
| KE-ST-006 | нет | status | не процитирован DEMO-SEM-012 | да | ограничение мок-провайдера: нужный документ был в контексте, но мок его не процитировал |
| KE-SEM-011 | нет | synthesis | нет `mapping_state = retired` | нет | retrieval: нужный раздел документа не попал в контекст |
| KE-SEM-012 | **да** | synthesis | нет `ROLE-014`, `E-MAP-001` | нет | retrieval: выбор фрагментов |
| KE-INTA-012 | нет | synthesis | не процитирован DEMO-INT-002 | нет | retrieval: соседний документ не попал в контекст |
| KE-SRC-012 | нет | synthesis | не процитирован DEMO-SRC-004, нет `mdm_golden_id`, `mdm_match_score` | нет | retrieval: выбор фрагментов |
| KE-SRC-004 | **да** | synonym | DEMO-SRC-008 на 8-м месте, ожидался в топ-3 | — | ранжирование поиска по синониму |
| KX-RAG-04 | **да** | external_rag | не процитирована страница Confluence 200104, нет «internal» | нет | оркестрация: локальных источников сочтено достаточно, внешний не подключён |

Ни одной ошибки в gold-кейсах или фикстурах не найдено. Исправлять эти кейсы правкой мока или gold — значит подгонять
результат под тест. На трёх holdout-кейсах настраивать нельзя. Следующий шаг описан в `04_DEFERRED.md`: отдельная задача по выбору фрагментов, с замером до и после.

## 5. Регрессионные тесты ветки: RED → GREEN

| Пакет | Тест | На исходном коде | После |
|---|---|---|---|
| A1 восстановление | `test_work_restore.py` | 3 RED | 6/6 |
| A2 ответ модели | `test_work_ai_robustness.py` (ломаные ответы) | 12 RED | 13/13 |
| A3 границы дат | `test_work_ai_robustness.py` (даты) | 11 RED | 14/14 |
| A4 префикс шаблона | `test_template_prefix_ownership.py` | 4 RED | 4/4 |
| A5 SQLite busy | `test_storage_busy.py` | 2 RED | 9/9 |
| B1 несохранённые правки | `leaveGuard.test.tsx`, `leaveGuardProgrammatic.test.tsx`, e2e B-07 | 5 из 6 RED | 9/9, e2e зелёный |
| P3 | `test_work_p3_remediation.py`, `test_sync_and_graph.py`, `test_metadata_pipeline.py`, `inlineDateLabel.test.tsx` | RED | зелёные |
| C1 eval exit | `test_knowledge_eval_exit.py` | RED | 6/6 |
| C2 synthetic | `test_knowledge_base.py`, `test_repo_hygiene.py` | RED (9 файлов) | зелёные |
| D производительность | `test_work_perf_equivalence.py` (равенство со старыми алгоритмами), `workBoardWindow.test.tsx` (7) | — (это оптимизация, поведение не меняется) | зелёные |
| Изоляция E2E | `test_e2e_stack_isolation.py` | RED | 1/1 |

Существующие тесты не переписывались ради зелёного результата.

## 6. Критерии готовности из ТЗ

| Критерий | Чем подтверждено |
|---|---|
| Нет необработанных 500 в исправленных местах | A2: 12 ломаных ответов → 502; A3: 9999 → 422; A5: блокировка → 503; SYS-001: 404. Тесты проверяют и отсутствие трассировки в ответе. В нагрузочных прогонах B2 — 0 ответов 5xx |
| Восстановление: глубина ≤ 4, правила вех | `test_work_restore.py` |
| Отказ — без частичных записей | тесты A1, A3, A5 проверяют задачи, версии, `plan_revision` и аудит после отказа |
| Блокировка SQLite — управляемый отказ | `503 storage_busy` + `Retry-After`, повтор идемпотентен |
| Редактор предупреждает о потере правок | vitest + e2e B-07 |
| Eval честно сигнализирует провал | exit 1 (make — 2) при 9 провалах |
| Демо-вход и права не менялись | `authz.py`, `permissions.py`, `deploy/`, Caddy не менялись (`git diff 96f133c HEAD` по ним пустой) |
| Без merge, push и deploy | ветка только локальная |
