# 00 — Реализация навыков «Работы» в чате (M7)

Задание: пакет `SKH_CHAT_WORK_SKILLS_M7` (папка владельца, в репозиторий не добавлялась). Ветка
`feature/skh-chat-work-skills`, создана от `3946fab` — головы `feat/skh-local-first-adaptive-rag` (PR #2, не смёржен).
Почему не от `main` (`f4ea26e`, ориентир пакета): M7 правит те же файлы, что PR #2 (`assistant.py`, `AskResponse`,
`TOOL_POLICY` v5, `AssistantTurn`), и стенд уже работает на `3946fab`. До слияния PR #2 этот PR будет показывать и его
коммиты; ветку можно перенести на `main` (`git rebase --onto main 3946fab`) после решения по PR #2.

Push, merge и deploy не выполнялись. Платных и живых вызовов модели не было: только скриптовый двойник
(`backend/tests/support/scripted_model.py`). Работы на Hetzner/Timeweb/RemoteKVM не было.

## Что сделано

### Три навыка (`backend/app/domain/skills.py`, `backend/app/services/work_skills.py`)

| Навык | runner | Требует | Что вызывает |
|---|---|---|---|
| `analyze_project` «Проанализировать проект» (read) | `work_read` | проект; `view_tasks` | `WorkInspector` (`get_project_schedule` + `get_task`) → цикл M5.7 с раундом 0 или серверная сводка |
| `draft_task_plan` «Составить план задач» (draft) | `work_plan` | проект; `propose_work`; `plan_work` у провайдера | `WorkAiService.propose` / `.revise` → WAP |
| `propose_task_changes` «Предложить изменения задач» (draft) | `work_change` | проект; `propose_work` + `edit_task`; `plan_work_changes` | `WorkChangeService.propose` / `.revise` → WCP |

- Права — до любого вызова модели. Глобальные `Action` проверяет маршрут (`api/assistant.py::_plan`). `WorkPrincipal`
  собирает ТОТ ЖЕ построитель, что API «Работы» (`api/work.py::work_principal`; `acting()` переведён на него).
  Проектный шлюз — `WorkService.chat_target` (тот же `_project_for` + `gate.check`).
- Модуль выключен → 503, нет прав или режим только просмотра → 403, mock или нет возможности у провайдера → 503
  `skill_unavailable`. Каталог показывает недоступность с причиной.
- Принцип «одна система»: второй базы задач, второго планировщика и второго формата плана нет. WAP создаёт
  `WorkAiService`, изменения пишет только `WorkService`.

### Change-set существующих задач (`backend/app/work/changes.py`, схема v4)

- Протокол `adapters/ai/work_change_protocol.py` не зависит от вендора; `plan_work_changes` есть у `openai_compatible` и
  `claude_cli`.
- Строгий разбор типов; смысл проверяет `validate_changes`:
  - разрешённые поля: `title`, `description`, `status`, `priority`, `due_date`;
  - значения проверяются по тем же правилам, что правка задачи;
  - `before` и версию задачи читает сервер.
- Таблица `work_task_change_proposals` (миграция v4, плюс `work_ai_proposals.revised_from`). Устаревание вычисляется при
  чтении.
- `WorkService.apply_task_change_set` — одна транзакция: одно повышение версии на задачу, одно — ревизии плана, аудит по
  задачам, идемпотентность, полный откат при любой ошибке; шов для внедрения сбоя `_after_change_write`.
- Маршруты `POST/GET /api/work-ai/change-proposals[/{id}[/preview|/apply|/revise|/reject]]`.

### Уточнение плана (многоходовость)

- `WorkAiService.revise` и `POST /api/work-ai/proposals/{id}/revise` создают НОВЫЙ WAP с `revised_from`.
- До вызова модели перепроверяются владелец, статус, ревизия плана, срок и источники.
- `WorkPlanRequest` получил необязательные `refinement` и `previous_plan`. Без них системный промпт и сообщение прежние
  байт в байт (тест `test_the_m6_plan_prompt_is_unchanged_without_a_refinement`).
- Идемпотентность чата: `work_context.client_request_id` → `work_idempotency` в той же транзакции, что и предложение.
  Повтор проверяется ДО вызова модели.

### Анализ проекта

- `SeededCall` в `ToolLoop.run(seed=…)` — минимальное аддитивное расширение цикла M5.7. Вызовы, уже выполненные сервером,
  записываются как раунд 0 через те же `_record` / факты, поэтому валидация `[F…]` прежняя.
- Факт строит одна общая функция `work_inspect_result`, её используют и инструмент `work_inspect`, и навык.
- В этом ходе нет предварительного поиска по базе знаний: ни переформулировки, ни проверки полноты, ни следа поиска.
  `drafts_propose` не предлагается.
- Без модели с инструментами сервер сам перечисляет факты с пометкой.

### API ассистента и история

- `AskRequest.work_context` (strict) и `AskResponse.work_proposal` (`WorkProposalRef`, отдельно от `proposal`) —
  аддитивные поля.
- `StoredTurnRequest.work` хранит ссылки и ключ отправки; у других ходов прежний вид без ключа.

### Интерфейс

- `Composer`: строка «Проект» (без автоподстановки), «Задачи» и чип «Уточняю WAP-…».
- `AskWorkProposal`: карточка перечитывает текущее состояние из API «Работы» и не обращается к документному API.
- `WorkChangeSheet` (`?changes=WCP-…` на странице проекта); в проверке WAP добавлена строка «Уточнение предложения».

### Политика ассистента

`TOOL_POLICY.md` версии 6: поправлен только пункт о модуле «Работа». Задачи из чата не создаются и не меняются,
предложения подтверждает человек, слова в чате ничего не применяют, раунд 0 — проверка самого сервера.

## Отступления от предложенного пакетом контракта (минимальные, мотивированные)

- `TaskChangesProposalOut` назван `WorkChangeProposalOut`, по образцу `WorkProposalOut`. Операции содержат
  `operation_id` и `current` — текущее значение, которое показывается, если оно отличается от `before`.
- Идемпотентность создания WCP и WAP из чата хранится в существующей `work_idempotency`, а не в колонке
  `client_request_id` новой таблицы. Так её проверяет тот же механизм, что у остальных операций «Работы».
- Повторное «Отклонить» → `409 proposal_stale` (`already_rejected`), как у WAP.
- Уточнение WCP поддержано (`revise`) — новое предложение с операциями исходного как данными. Правка значения
  операции прямо в панели не сделана: значение правится в карточке задачи (§4 пакета это допускает).
- В панели ассистента документа карточка показывает ссылку в проект, без кнопки «Уточнить».
