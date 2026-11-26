# 02 — Результаты проверок

Итоговый код: `bab049f` (ветка `feat/skh-local-first-adaptive-rag`). Машина разработчика, Apple M5, 26.11.2026.
Логи (без локальных путей) — `evidence/`.

## 1. Регрессионный гейт

| Команда | Exit | Результат | Лог |
|---|---:|---|---|
| `make check` (ruff, ruff format, mypy strict, tsc, eslint, pytest, vitest) | **0** | ruff и format OK; mypy: 0 ошибок в 147 файлах; **pytest 1433 passed, 6 skipped**; **vitest 734/734** (61 файл) | `make_check.log` |
| `make knowledge-eval` | **2** | **210/216**, те же 6 FAIL, что у `9b9f3c7` (KE-ADR-005, KX-RAG-04, KE-INTA-012, KE-SRC-004, KE-SRC-012, KE-SRC-013); R@1 0,9487, R@5 0,9744, MRR 0,9647, утечек 0; по кейсам отличаются только `latency_ms` | `make_knowledge_eval.log` |
| `make mock-kb-validate` | **0** | RESULT: OK | `make_mock_kb_validate.log` |
| `make work-eval` | **0** | 17/17 | `make_work_eval.log` |
| `pytest test_external_rag test_assistant test_assistant_tool_loop test_adaptive_rag test_evidence_gate test_gap_protocol test_gap_providers test_gate_eval` | **0** | 202 passed | `targeted_pytest.log` |
| `E2E_BASE_URL=…:5177 npx playwright test` (desktop + mobile + gitlab-mock, офлайн-стенд, Confluence выключен) | **0** | **102 passed, 9 skipped, 0 failed** (столько же пропусков, сколько до задачи) | `e2e_main.log` |
| `E2E_SKIP_GITLAB_STACK=1 E2E_SCRIPTED_URL=…:5186 npx playwright test --project=scripted --project=scripted-mobile` (scripted-модель, Confluence выключен) | **0** | 23 passed, 2 skipped (новый сценарий ворот без Confluence пропускается — так задумано) | `e2e_scripted.log` |
| `… E2E_SCRIPTED_URL=…:5187 npx playwright test e2e/adaptiveRag.spec.ts --project=scripted` (scripted-модель + mock Confluence) | **0** | 2 passed | `e2e_adaptive_rag_with_confluence.log` |
| `gate_eval --validate` | **0** | 40 кейсов, 20 dev / 20 holdout, 0 проблем | — |

`make knowledge-eval` красный честно: exit не замаскирован, кейсы не ослаблены. Файлы `reports/knowledge-eval/after*`,
перезаписанные этим прогоном, возвращены к закоммиченной версии: отличались только задержками и SHA.

Первый прогон `make check` на `9df11cc` упал на `ruff format --check` (два тестовых файла после дописывания);
исправлено отдельным коммитом `bab049f`, повторный прогон — exit 0.

**6 skipped в pytest** — live-тесты (`tests/live/`), требуют `SKH_LIVE_TESTS=1`: LIVE_LLM_NOT_TESTED.

E2E-стенды изолированы: состояние в scratchpad сессии, синтетические данные, loopback test doubles (GitLab :8929,
Confluence MCP :8930, Confluence REST :8931, scripted-модель :8023). После прогонов стенды остановлены. Реальные
системы, Hetzner и рабочий `workspace/` не затрагивались.

## 2. Промежуточные коммиты

Тесты каждого коммита в отдельном временном worktree (`intermediate_commits.log`):

| Коммит | Результат |
|---|---|
| `49c8ce7` ворота + протокол | 185 passed |
| `25b4f47` провайдеры | 191 passed |
| `eb3c7a2` приёмочные тесты LF | 220 passed |
| `51ee674` UI | `tsc` OK, `ask.test.tsx` 30/30 |
| `9c909f2` карточки | 223 passed |
| `313403c` фокусные фрагменты | **223 passed, 1 failed** — новый тест импортирует `app/evaluation/gate_eval.py`, который добавлен следующим коммитом `1fdc682`; код не затронут. История не переписывалась |
| `1fdc682` оценка (заморозка) | 226 passed |

## 3. Новые тесты

| Файл | Тестов | Что проверяет |
|---|---:|---|
| `backend/tests/test_gap_protocol.py` | 36 | контракт ответа: ограда и текст вокруг, проза/«да»/строка/массив → syntax, `{}`/лишний ключ/неизвестный decision/неверный тип/10 запросов/длина/E7/чужой ID/противоречия → schema, слишком длинный ответ, дубли и управляющие символы, URL/хост/IP/путь/`?key=` в запросе, сохранение ID, операторы, экранирование разделителей, размер промпта, repair-пометка |
| `backend/tests/test_evidence_gate.py` | 20 | карточки (по документу, ≤ 5, бюджет, только командные фрагменты, статусы), выдержки по редким словам, отсутствующие слова как факт сервера, один repair только для syntax, invalid → правило v2 / `local`, таймаут и ошибка провайдера, защита по ID для «sufficient», uncertain → одна проба, отклонение небезопасных запросов, замена «вопроса целиком», без локальных фрагментов — без модели, политика `lexical` и провайдер без capability, бюджет частоты по ACL-scope, сводка без текстов |
| `backend/tests/test_adaptive_rag.py` | 30 | матрица LF-01…LF-26 сквозь API на новом мини-корпусе и mock Confluence (вкл. 120 шумных страниц) + фокусный выбор фрагментов |
| `backend/tests/test_gap_providers.py` | 6 | проводной контракт `internal_api` (один chat completion, `temperature 0`, без `tools`/`response_format`) и `claude_cli`; пробел как данные в промпте ответа и в раунде tool loop; tool loop не ищет повторно; repair по проводу |
| `backend/tests/test_gate_eval.py` | 2 | проверка разметки и подсчёт ложных/пропущенных внешних вызовов |
| `frontend/src/__tests__/ask.test.tsx` | +2 | строка прогресса «Проверяю…» / «Ищу недостающее…», неизвестный шаг игнорируется; причина и исход внешнего поиска словами |
| `frontend/e2e/adaptiveRag.spec.ts` | 2 | сквозь браузер: пробел → Confluence с причиной словами; достаточно → без вызова |

Тесты протокола и ворот написаны до кода (RED: модуль отсутствовал), правки по dev-диагностике — тоже тестами вперёд
(три теста в `test_evidence_gate.py` и тест фокусных фрагментов падали до правки). Существующие тесты не менялись.

## 4. Матрица приёмки LF-01…LF-26

| ID | Тест (`test_adaptive_rag.py`, если не указано) | Итог |
|---|---|---|
| LF-01 | `test_lf01_facts_in_two_documents_are_sufficient_without_any_external_call` | PASS |
| LF-02 | `test_lf02_no_local_passage_searches_once_without_a_model_call` | PASS |
| LF-03 | `test_lf03_…_local_evidence_is_kept` (+ цитата Confluence с версией и статусом) | PASS |
| LF-04 | `test_lf04_a_paraphrase_is_not_a_reason_to_search_externally` | PASS |
| LF-05 | `test_lf05_a_focused_query_finds_the_requirement_among_many_similar_pages` | PASS |
| LF-06 | `test_lf06_an_external_page_never_replaces_an_approved_local_fact` | PASS |
| LF-07 | `test_lf07_team_scope_never_calls_confluence_or_the_gap_model` | PASS |
| LF-08 | `test_lf08_corporate_scope_searches_without_a_local_first_decision` | PASS |
| LF-09 | `test_lf09_explicit_external_search_is_forced_without_claiming_a_local_gap` | PASS |
| LF-10 | `test_lf10_a_confluence_copy_of_an_approved_document_is_not_second_evidence` | PASS |
| LF-11, LF-26 | `test_lf11_lf26_a_revoked_or_changed_page_is_never_cited_from_the_cache` | PASS |
| LF-12 | `test_lf12_restricted_pages_and_an_unavailable_connector` | PASS |
| LF-13 | `test_lf13_an_injected_instruction_cannot_turn_into_an_action` | PASS |
| LF-14 | `test_lf14_malformed_replies_…` (3 варианта) | PASS |
| LF-15 | `test_lf15_a_confident_sufficient_without_the_identifier_is_not_accepted` | PASS |
| LF-16 | `test_lf16_a_model_that_always_asks_for_more_is_bounded_by_the_rate_budget` | PASS |
| LF-17 | `test_lf17_duplicate_queries_are_searched_once` | PASS |
| LF-18 | `test_lf18_stream_and_ask_give_the_same_decision_sources_and_calls` | PASS |
| LF-19 | `test_lf19_nothing_found_externally_is_reported_as_unconfirmed_not_as_absent` | PASS |
| LF-20 | `test_lf20_a_follow_up_is_re_scoped_by_the_server` | PASS |
| LF-21 | `test_lf21_two_independent_aspects_give_two_focused_searches_at_most` | PASS |
| LF-22 | `test_lf22_an_identifier_of_the_question_stays_in_the_query` | PASS |
| LF-23 | `test_lf23_a_draft_never_becomes_evidence_for_the_gap_model` | PASS |
| LF-24 | `test_lf24_the_offline_mock_keeps_the_lexical_rule_and_simulates_nothing` | PASS |
| LF-25 | `test_lf25_a_slow_model_and_a_slow_wiki_degrade_within_the_time_limits` | PASS |

Ограничение LF-15: сервер ловит уверенное «sufficient», только если в цитируемых фрагментах нет идентификатора
вопроса; смысловую ошибку без ID он не видит (`04_WEAK_MODEL.md`, `05_LIMITATIONS.md`).
