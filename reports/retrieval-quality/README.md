# Retrieval Quality Improvement (post-M6) — итог

Ветка `fix/skh-retrieval-quality` от `main` `f4ea26e`. Код: коммиты `2a89155`, `6833264`, `761944b`, `8c0d2f7`
(последний код — `8c0d2f7fdb260e63962d71acc998e67556059a6b`), затем коммит с документацией и отчётами. Не запушена, не слита, не развёрнута.

| Отчёт | Содержание |
|---|---|
| [00_BASELINE.md](00_BASELINE.md) | SHA, хэши базы и кейсов, baseline 207/216, протокол защиты holdout |
| [01_ROOT_CAUSE_MATRIX.md](01_ROOT_CAUSE_MATRIX.md) | путь вопроса, стадии потери для 6 дефектов, mock или retrieval |
| [02_DESIGN_AND_CHANGES.md](02_DESIGN_AND_CHANGES.md) | выбранное решение, измеренные альтернативы, файлы |
| [03_BEFORE_AFTER.md](03_BEFORE_AFTER.md) | метрики, все флипы, tuning и holdout, пробы, латентность, MCP, цитаты |
| [04_TEST_RESULTS.md](04_TEST_RESULTS.md) | команды, exit codes, изменённые и новые тесты, RED-проверка |
| [05_REMAINING_RISKS.md](05_REMAINING_RISKS.md) | что осталось красным и почему, риски, ограничения |
| `eval/`, `evidence/`, `tools/` | машиночитаемые результаты, санитизированные трассы и логи, воспроизводимые скрипты |

## Шесть retrieval-дефектов

| Кейс | Holdout | Итог |
|---|---|---|
| KE-SEM-011 | нет | **FIXED** |
| KE-SEM-012 | да | **FIXED** (слепой прогон) |
| KE-SRC-012 | нет | **PARTIAL** |
| KE-INTA-012 | нет | **UNRESOLVED** |
| KE-SRC-004 | да | **UNRESOLVED** |
| KX-RAG-04 | да | **UNRESOLVED** |

## Результат (216 кейсов, mock, без сети)

| Показатель | Before (`f4ea26e`) | After |
|---|---:|---:|
| PASS | 207/216 | **210/216** (PARTIAL: цель ≥ 213) |
| PASS → FAIL | — | **0** |
| `context_ok` | 0,9057 | **0,9434** |
| Recall@1 / Recall@5 / MRR | 0,9487 / 0,9744 / 0,9647 | 0,9487 / 0,9744 / 0,9647 |
| Утечки / невалидные цитаты | 0 / 0 из 168 | **0 / 0 из 167** |
| Holdout | 29/32, `context_ok` 0,7143 | **30/32, 0,8571** |
| Tuning (184) | 178, 0,9348 | **180, 0,9565** |
| Независимые пробы (22) | 13 | **15** |
| `/api/assistant/ask` p95 | 30,5–31,5 мс | 33,8–35,2 мс (+7–16 %, бюджет +25 %) |
| `/api/search` p95 | 15,4–16,7 мс | 15,1–16,2 мс (шум) |
| MCP: вызовы / страницы (19 вопросов) | 33 / 17 | 33 / 17 |

`make check` 0 (pytest 1339 passed, 6 skipped live; vitest 732/732) · `make work-eval` 17/17 ·
`make mock-kb-validate` OK · E2E 102 passed, 9 skipped, 0 failed · `make knowledge-eval` честно красный (exit 2):
2 mock-only провала + 4 retrieval-провала.

## Ограничения

- Только синтетическая база и mock Confluence.
- Live LLM не проверялся (LIVE_LLM_NOT_TESTED).
- Латентность — внутрипроцессный замер на Apple M5, не Hetzner.
- Holdout: run 1 был слепым. Run 2 — контрольный после правки по E2E, совпал по каждому кейсу. Для KE-SRC-004 и
  KX-RAG-04 диагностика прочитана, поэтому следующая работа над ними требует нового holdout.
- Порог 10 % для специфических слов выбран на 13 tuning-кейсах.
- Решение по словам с df = 0 (KX-RAG-04) — за владельцем.

Подробности — в `05_REMAINING_RISKS.md`.
