# 00 — Основание ветки и baseline

## 1. Ветка и исходное состояние

| | |
|---|---|
| Рабочая ветка | `feat/skh-local-first-adaptive-rag` (локальная, не запушена) |
| Основание | `fix/skh-retrieval-quality` @ `9b9f3c7b4564a22dad99c3033f87f0a48d4da6d1` (5 коммитов поверх `main`) |
| `main` | `f4ea26e8e3a4e820ed583b68b1d3abf9d04ac396` |
| Рабочее дерево до начала | чистое, кроме папок владельца `Claude outputs/`, `m6 copy/`, `planner-v2-handoff/` и папки задания `SKH_Local_First_Adaptive_RAG_Weak_LLM_Task/` — не тронуты, не закоммичены |
| Код заморожен перед holdout | `1fdc682f91b4a5420871b288d0656c4cfc73b602` |

Ветка `fix/skh-retrieval-quality` существует локально с заявленным SHA `9b9f3c7`, работа начата от неё; сама ветка не
изменена.

## 2. Baseline, перепроверенный на `9b9f3c7` (до правок)

| Проверка | Результат |
|---|---|
| `python -m app.evaluation.knowledge_eval … --label before` | **210/216**, 6 FAIL (KE-ADR-005, KX-RAG-04, KE-INTA-012, KE-SRC-004, KE-SRC-012, KE-SRC-013), R@1 0,9487, R@5 0,9744, MRR 0,9647, утечек 0, exit 1 (`evidence/base_knowledge_eval.log`) |
| `pytest tests/test_external_rag.py tests/test_assistant.py tests/test_assistant_tool_loop.py` | exit 0 (`evidence/base_targeted_pytest.log`) |

Заявленные 210/216 подтверждены измерением. Это результат детерминированной оценки с mock-провайдером на
синтетической базе, а не факт о сервере.

## 3. Хэши корпуса и кейсов

| Объект | SHA-256 |
|---|---|
| `fixtures/knowledge/**/*.md` (конкатенация по пути) | `48bcff93c09e79e12d1884c86c48d9efff8ada6113101ade77e1756349a2f3ad` |
| `fixtures/confluence_mock/pages.yaml` | `691b1ab052fed6653eb0169d43c9f58caa55aca1dbb39758c55415a34254ccb1` |
| `fixtures/eval_adaptive/cases.yaml` (новая выборка) | `99b1f078afe41e235fff6290fd6e7c6fd6731651d23640b849a9544c9a105f56` |

Корпус `fixtures/knowledge` и mock Confluence одинаковы в `main`, `9b9f3c7` и этой ветке (`git diff` пуст).
Gold-кейсы `fixtures/eval`, holdout, `mock.py`, словарь и `knowledge_eval.py` не менялись.

## 4. Карта вызовов (до изменений)

```text
POST /api/assistant/ask        → SkillService.run        → AssistantService.ask
POST /api/assistant/ask/stream → SkillService.run_stream → AssistantService.ask_stream
  _prepare: анализ вопроса → локальные фрагменты (retrieval.passages) → частоты слов
    corporate ∈ sources и коннектор включён:
      только corporate          → trigger external_scope_selected
      search_external           → trigger explicit_request
      иначе local_insufficiency (LOCAL_SUFFICIENCY v2, лексическое правило) → код причины или «достаточно»
      причина есть → ExternalEvidenceService.retrieve(question …) — в MCP уходит ВЕСЬ вопрос
  tool_mode (internal_api, claude_cli): M5.7 tool loop получает уже готовые фрагменты; инструмента Confluence нет
  иначе provider.answer / stream_answer
  → _finish / _finish_tools → серверная проверка цитат → _record (provenance, discovery trace)
```

Решение о Confluence принималось до tool loop и одинаково для `/ask` и `/ask/stream`; модель в нём не участвовала.
