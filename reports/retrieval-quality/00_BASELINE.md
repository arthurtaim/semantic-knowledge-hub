# 00 — Baseline: воспроизводимая отправная точка

Baseline снят **до любых изменений кода**, на чистом `main`, с той же командой, что и итоговый прогон.

## 1. Ревизия и входные данные

| Что | Значение |
|---|---|
| Код | `f4ea26e8e3a4e820ed583b68b1d3abf9d04ac396` (`main`, merge PR #1, 2026-11-26T04:43:33+01:00) |
| Ветка работы | `fix/skh-retrieval-quality`, создана от `f4ea26e` |
| `git status` при baseline | отслеживаемых изменений нет. Неотслеживаемые папки владельца (`Claude outputs/`, `m6 copy/`, `planner-v2-handoff/`) не трогались; из-за них отчёт пишет `worktree_dirty: true` |
| База знаний | `fixtures/knowledge`, 83 синтетических документа, `kb_snapshot_hash` **`4cc6e409e5231bb3`** |
| Кейсы | `fixtures/eval`, 216 кейсов (184 tuning + 32 holdout), `cases_hash` **`395a00146d3c1d34`** |
| Словарь поиска | `dictionary.yaml` sha256/12 `30f06b6eebfd` (не менялся) |
| Режим | mock AI (детерминированный, без LLM), mock Confluence (`fixtures/confluence_mock/pages.yaml`, 24 синтетические страницы), без сети; временный workspace на каждый прогон, `index_generation` 1 |
| Машина | Apple M5 (darwin arm64), общая рабочая машина |
| Backend | Python 3.12.15, SQLite 3.54.1, FastAPI 0.165.0, Pydantic 2.14.4, PyYAML 6.0.4, pytest 9.2.0, ruff 0.17.6, mypy 1.20.2 |
| Frontend | Node v26.13.0, vitest 3.2.7, TypeScript 5.9.3 |

## 2. Команда

```bash
cd backend
../.venv/bin/python -m app.evaluation.knowledge_eval \
  --kb ../fixtures/knowledge --cases ../fixtures/eval \
  --label before --out ../reports/retrieval-quality/eval
```

Exit code **1**: при красных кейсах это ожидаемо, runner не сломан. Полный вывод: `evidence/before_run.log`;
машиночитаемые результаты: `eval/before.json`, `eval/before_metrics.csv`, `eval/before_failures.md`.

## 3. Результат: совпадает с историческим ориентиром

| Показатель | Исторический ориентир | Baseline на `f4ea26e` |
|---|---:|---:|
| Кейсы | 216 | 216 |
| PASS / FAIL / ERROR / UNSUPPORTED | 207 / 9 / 0 / 0 | **207 / 9 / 0 / 0** |
| Recall@1 | 0,9487 | **0,9487** |
| Recall@5 | 0,9744 | **0,9744** |
| MRR | 0,9647 | **0,9647** |
| `context_ok` | 0,9057 | **0,9057** |
| Утечки draft/deprecated/restricted | 0 | **0** |
| Holdout | 29/32, `context_ok` 0,7143 | **29/32, `context_ok` 0,7143** |

Расхождений с историческим отчётом нет, так что прогоны сопоставимы.

| Часть набора | Кейсы | PASS | R@1 | R@5 | MRR | `context_ok` |
|---|---:|---:|---:|---:|---:|---:|
| Tuning (без holdout) | 184 | 178 | 1,0 | 1,0 | 1,0 | 0,9348 |
| Holdout | 32 | 29 | 0,8182 | 0,9091 | 0,875 | 0,7143 |

По категориям: всё 100 %, кроме `synthesis` 4/10, `status` 9/10, `synonym` 13/14 и `external_rag` 11/12. Полный список — в
`evidence/before_run.log`.

**Провалы baseline:**
- tuning: `KE-ADR-005`, `KE-INTA-012`, `KE-SEM-011`, `KE-SRC-012`, `KE-SRC-013`, `KE-ST-006`;
- holdout: `KE-SEM-012`, `KE-SRC-004`, `KX-RAG-04`.

## 4. Протокол, защищающий holdout

1. **Tuning-manifest.** Генерируется скриптом `tools/make_tuning_manifest.py` во временный каталог вне `fixtures/eval`.
   Holdout исключается по флагу `holdout: true` самих кейсов, а не по списку ID «по памяти». Список 184 ID и хэши
   исходных файлов лежат в `evidence/tuning_manifest.txt` (manifest sha256/16 `cdf7eaafa1aa388a`). Итерации шли только
   на нём: `tuning_before` = 178/184.
2. **Независимые tuning-пробы.** 22 пробы в `fixtures/eval_tuning/cases_retrieval_tuning.yaml` написаны по содержимому
   *других* документов и страниц, до любых изменений кода. Это DEMO-GOV-008, INT-004/005, INT-011/012, SRC-005 и
   страницы 200105/107/115/123; не SEM-006, не SRC-008, не 200104 — то есть не то, о чём holdout-кейсы. Пробы
   прогнаны на baseline: `eval/probes_before.json` = 13/22.
3. **Тексты holdout-кейсов** во время работы не открывались. Скрипт просмотра печатал для holdout только ID, метод и
   категорию. Инструмент трассировки `app.evaluation.retrieval_trace` отказывается трассировать holdout без
   `--allow-holdout` (это проверяет тест).
4. **Holdout-прогон** (полный набор из 216) выполнен **один раз**, после заморозки кода (`03_BEFORE_AFTER.md`).
   Диагностика holdout-провалов сделана после этого прогона. По её результатам код **не менялся**.
5. **Gold, holdout, oracle, verifier, `mock.py`, `dictionary.yaml`** не менялись (`git diff f4ea26e -- fixtures/eval
   backend/app/adapters/ai backend/app/search_dictionary backend/app/evaluation/knowledge_eval.py` пуст).

Рабочие БД не затрагивались. Каждый прогон идёт во временном каталоге (`eval_client`). `workspace/work.sqlite3`
не менялся с 2026-11-25 19:25, это проверено после всех прогонов и бенчмарков.
