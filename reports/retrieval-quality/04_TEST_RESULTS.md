# 04 — Результаты проверок

Все числа — из реальных прогонов 26.11.2026 на итоговом коде ветки `fix/skh-retrieval-quality`, на той же машине
(Apple M5). Среда — в `00_BASELINE.md` §1. Логи — в `evidence/`.

## 1. Сводка

| Команда | Exit | Результат | Лог |
|---|---:|---|---|
| `make check` (ruff, ruff format, mypy strict, tsc, eslint, pytest, vitest) | **0** | ruff и format OK; mypy: 0 ошибок в 143 файлах; tsc и eslint OK; **pytest 1339 passed, 6 skipped**; **vitest 732/732** (61 файл) | `evidence/make_check.log` |
| `make mock-kb-validate` | **0** | RESULT: OK, `validation.json` не изменился (база знаний не менялась) | `evidence/make_mock_kb_validate.log` |
| `make work-eval` (M6) | **0** | 17/17 PASS | `evidence/make_work_eval.log` |
| `make knowledge-eval` | **2** (модуль 1) | 210/216 PASS, 6 FAIL, 0 ERROR, 0 UNSUPPORTED; R@1 0,9487, R@5 0,9744, MRR 0,9647, утечек 0 | `evidence/make_knowledge_eval.log` |
| полный прогон с `--label after` | 1 | идентичен `make knowledge-eval` | `evidence/after_run.log` |
| `npx playwright test` (desktop + mobile + gitlab-mock) | **0** | **102 passed, 9 skipped, 0 failed** | `evidence/e2e.log` |
| tuning-пробы (22) | 1 | 15/22 | `eval/probes_after.json` |
| `tools/red_check.sh f4ea26e` | — | новые тесты на старом коде: **14 FAIL** (все помеченные «v1 failed»), 13 PASS (защитные) | `evidence/red_check_v1.log` |
| `tools/citation_audit.py` | — | 0 нарушений из 167 цитат (before: 0 из 168) | `evidence/citation_audit_*.json` |

`make knowledge-eval` красный честно: exit code не замаскирован, кейсы не ослаблены. Остались 2 mock-провала и 4
retrieval-провала (`05_REMAINING_RISKS.md`).

**6 skipped в pytest** — это live-тесты: `tests/live/test_claude_cli_live.py` (4) и
`tests/live/test_live_readonly.py` (2). Они требуют `SKH_LIVE_TESTS=1` и туннеля к стенду. Live LLM в этой задаче
запрещён: **LIVE_LLM_NOT_TESTED**.

**9 skipped в E2E** — пропуски заданы в самих тестах, до изменений их было столько же:
- 7 сценариев `AI_PROVIDER=disabled` (C-04/C-05, B-05/B-06, D-05/D-06, Template Studio «with AI disabled»): для них
  нужен стенд с отключённым ИИ;
- «M5.6 ask with both sources»: нужен включённый Confluence, а E2E-стенд по соглашению проекта идёт с Confluence
  disabled. Внешний источник покрыт pytest-тестами на mock Confluence;
- «M6 read-only exposure»: нужен публичный стенд или стенд без записи.

Прошли все сценарии `work.spec` (14), `templateStudio` (4), `graph` (11), `excerpts` (2), `assistant`, `chatHistory`,
`documents` и др.

E2E-стенд изолирован. Офлайн-backend `:8012` и Vite `:5177` держат всё состояние в scratchpad сессии, данные только
синтетические. GitLab, Confluence MCP и Confluence REST — loopback test doubles (`:8929`/`:8930`/`:8931`); Playwright
поднимает их сам. Реальные системы, Hetzner и рабочий `workspace/` не затрагивались.

## 2. Промежуточные прогоны (для полноты)

- **Первый `make check`** остановился на `ruff format --check`: новые тесты не были отформатированы. Исправлено
  `ruff format`.
- **Второй `make check`**: backend зелёный, frontend 731/732. `workBoardWindow.test.tsx` («the card menu moves a
  card…») упал по тайм-ауту 5000 мс, длительность 5224 мс. Этот файл (M6-доска) изменения не затрагивают. Отдельно он
  прошёл 3 из 3 раз за 574–755 мс, полный vitest — 732/732 (`evidence/vitest_rerun.log`), итоговый `make check` —
  732/732. Вывод: тест чувствителен к нагрузке, когда идёт после pytest; так было и до задачи. Тест не менялся.
- **Первый полный E2E** (до правила «документ по id — предмет»): 100 passed, 9 skipped, **2 failed** — `excerpts.spec`
  R2-01 и R2-02. Это была **регрессия продукта**: на вопрос об источнике и получателе DEMO-INT-001 ответ начинался с
  таблицы другого потока. Исправлено в коде (`02` §2.2 п. 0), тест `test_a_document_named_by_its_id_is_the_subject_of_the_question`.
  После этого оба сценария проходят на исходных ожиданиях, кроме одного слова в R2-01 (§3).

## 3. Изменённые существующие тесты и почему

| Тест | Было | Стало | Обоснование |
|---|---|---|---|
| `test_external_rag.py::test_external_only_page_is_cited_without_importing_it` | список допустимых причин содержал `no_single_local_passage` | `no_single_local_source`, `specific_terms_not_covered` | коды LOCAL_SUFFICIENCY v2. Поведение (вызов, страница 200101, факт) проверяется как прежде |
| `test_not_found_terms.py::test_search_terms_are_unchanged` → `test_function_words_are_not_search_terms` | утверждал, что служебные слова *остаются* поисковыми термами («изменение требует оценки») | утверждает, что *не остаются* | решение изменено по итогам оценки. Сам docstring теста требовал before/after-оценку для такого изменения |
| `test_not_found_terms.py::test_no_passages_message_names_only_meaningful_words`, `…_mock_insufficient_message_counts_function_words…` | термы со служебными словами из `analyze_query(...)` | из `analyze_query(..., keep_stopwords=True)` | проверяется та же логика *именования* в сообщении; служебные слова больше не приходят из поиска, поэтому их нужно подать явно |
| `test_not_found_terms.py::test_answer_does_not_list_function_words_as_not_found` | `confidence == "partial"`, с комментарием ««через», «который» still count in the coverage» | `"supported"` | «partial» был артефактом разбавления служебными словами — одной из найденных корневых причин. Единственный документ покрывает все содержательные слова. Проверка «служебные слова не названы» осталась |
| `test_not_found_terms.py::test_answer_lists_meaningful_missing_words_only` | одно отсутствующее слово «регламенту» давало partial только за счёт служебных слов | два отсутствующих слова: «регламенту», «графику» | проверка «назван смысловой пропуск, служебные слова не названы» сохранена |
| `frontend/e2e/excerpts.spec.ts` R2-01, последний блок | `Не найдено в документах: «часто»` | `«сбое»` | частота в ответе **есть** («каждые 6 часов»), нет только части про сбой. v1 называл «часто» из-за разбавления словом «будет». Проверка, что «будет» не названо, осталась |

Gold-кейсы, holdout, oracle, verifier и `knowledge_eval.py` не менялись (`00_BASELINE.md` §4).

## 4. Новые тесты

**`backend/tests/test_retrieval_quality.py`** — 24 теста на собственном синтетическом мини-корпусе каждого теста.
Ниже — что каждый проверяет; в скобках — как он ведёт себя на коде `f4ea26e` (`evidence/red_check_v1.log`):

- **анализ запроса:**
  - служебные слова не термы, акронимы — термы (v1: FAIL);
  - длинный составной вопрос сохраняет вторую часть (v1: FAIL);
  - беглая гласная ×4 (v1: FAIL);
  - правило беглой гласной не трогает «поток», «срок», «каталог», «процесс», «CRM» ×5 (защитный, PASS);
- **упаковка:**
  - поздняя секция, отвечающая на вторую часть вопроса, упакована (v1: FAIL);
  - документ контекста не вытесняется плотными секциями 70 других документов (v1: FAIL);
  - документ, названный по id, — предмет вопроса (v1: FAIL);
  - два факта в двух документах (защитный);
  - обзор не вытесняет документ с правилом (защитный);
- **статус, ACL, provenance:**
  - draft и deprecated исключены без явного запроса, draft включается по `include_drafts` (защитный);
  - документ вне снимка читателя не появляется во фрагментах и ранжировании, даже если он в индексе (защитный);
  - фрагменты дословны, со своим якорем и ревизией, порядок детерминирован, ≤ 6 фрагментов и ≤ 4 документов
    (защитный);
- **достаточность v2:**
  - тематически близкий источник без специфического слова недостаточен (v1: FAIL);
  - секции одного документа дополняют друг друга (v1: FAIL);
  - слова, разбросанные по документам, — не ответ (v1: FAIL только из-за нового кода причины, поведение v1 то же);
  - неизвестная сущность (защитный);
- **инструмент:** трасса отказывается от holdout-кейса (v1: FAIL — инструмента не было).

**`backend/tests/test_external_rag.py`** — 3 сквозных теста через API на mock Confluence:
- лимит пакета CATIA → внешний источник опрошен по `specific_terms_not_covered`, цитируется страница 200115 (v1: FAIL);
- `local_only` никогда не зовёт Confluence (защитный);
- достаточный локальный ответ про Archive Store без MCP-вызова, с «36 месяцев» из DEMO-GOV-008 (защитный).

**`frontend/src/__tests__/ask.test.tsx`** — новая причина показывается словами, а не кодом.

Защитные тесты проходят и на старом коде — это задумано: они фиксируют инварианты (статус, ACL, provenance,
local_only, детерминизм), которые изменение не должно сломать. Тесты, которые должны ловить старые ошибки, на старом
коде падают. Два из них поначалу проходили и на старом коде: их корпуса не воспроизводили условия ошибки. Корпуса
переделаны, и это проверено повторным RED-прогоном. Повторить: `reports/retrieval-quality/tools/red_check.sh`.

## 5. M5.7, M6, Template Studio, Planner v2

- **M5.7** — tool loop, `knowledge_search`, предварительный контекст.
  - `tests/test_assistant_tools.py`, `tests/test_assistant_tool_loop.py`, `tests/test_assistant.py` зелёные в составе
    pytest.
  - `knowledge_search` использует тот же `passages()`, поэтому получает v2 автоматически и с теми же фильтрами
    статуса и снимка.
- **M6** — `make work-eval` 17/17, `test_work_*` зелёные, E2E `work.spec` 14/14.
  `work_ai` использует `rank_documents`, ранжирование которого не менялось.
- **Template Studio и Template Hub** — категории `template` 8/8 и `template_hub` 10/10 в knowledge-eval;
  `test_template_studio.py` и `test_template_registry.py` зелёные; E2E `templateStudio.spec` 4 прошли (1 пропуск: AI disabled).
- **Planner v2** — vitest и E2E зелёные, код не менялся.
