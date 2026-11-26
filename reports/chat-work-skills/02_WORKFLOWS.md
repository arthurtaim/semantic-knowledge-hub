# 02 — Сценарии: чтение состояния до и после

Синтетические демо-проекты (ARIS, DQI, RAG), скриптовый двойник модели (`tests/support/scripted_model.py`), приложение
внутри процесса во временной папке (никакой общей или рабочей базы). Скрипт: `reports/chat-work-skills/workflows_evidence.py`
(запуск из `backend/`: `../.venv/bin/python ../reports/chat-work-skills/workflows_evidence.py`). Состояние читается
независимо через API «Работы» и базу: число задач, ревизия плана, число событий аудита, значения и версии задач.
Двойник отвечает по ключевым словам: это проверка поведения сервера, а не качества модели.

Браузерная проверка тех же сценариев — `frontend/e2e/workChat.spec.ts` (STORY-01/02, 03, 04, 07, телефон 375 px),
результаты — `01_TESTS.md`.

### Чат → план задач (WAP) → проверка → «Создать задачи»

- до: {"tasks": 14, "plan_revision": 1, "audit": 50}
- ответ чата: `work_proposal` = {"kind": "task_plan", "id": "WAP-f764c721743a0632", "project_key": "ARIS", "state": "ready", "app_path": "/projects/ARIS?proposal=WAP-f764c721743a0632", "task_count": 5, "dependency_count": 3, "change_count": 0, "revised_from": null, "requires_confirmation": true}
- после ответа: {"tasks": 14, "plan_revision": 1, "audit": 51} (задачи не созданы; +1 событие аудита `proposal_created`)
- проверка в проекте: state = ready · задач 5 · зависимостей 3 · источники ['SEM-ARCH-001']
- «Создать задачи»: создано 5 задач, 3 зависимостей, 2 связей; ревизия плана 2
- после применения: {"tasks": 19, "plan_revision": 2, "audit": 62}
- повтор того же подтверждения: replayed = True · {"tasks": 19, "plan_revision": 2, "audit": 62}

### Чат → изменения задач (WCP) → снять один пункт → «Применить изменения»

- до: [{"key": "ARIS-6", "status": "in_progress", "priority": "high", "due": "2026-11-19", "version": 1, "start": "2026-11-10", "end": "2026-11-20"}, {"key": "ARIS-8", "status": "in_progress", "priority": "medium", "due": null, "version": 1, "start": "2026-11-20", "end": "2026-11-26"}, {"key": "ARIS-14", "status": "todo", "priority": "critical", "due": "2026-12-10", "version": 1, "start": "2026-12-10", "end": "2026-12-10"}] {"tasks": 19, "plan_revision": 2, "audit": 62}
- ответ чата (текст):
```
Подготовлено предложение изменений WCP-6507cb46316f2461 для проекта ARIS: изменений 3 в задачах 3. Задачи НЕ изменены. «Было» прочитано из задач сервером:
- ARIS-6 · Статус: «in_progress» → «review»
- ARIS-8 · Приоритет: «medium» → «high»
- ARIS-14 · Срок: «2026-12-10» → «2027-01-20»
Откройте «Проверить изменения»: снимите лишние пункты и подтвердите «Применить изменения» — всё применится одной операцией или не применится ничего.
```
- после ответа (задачи не изменены): {"tasks": 19, "plan_revision": 2, "audit": 63}
- применено операций: 2 · задачи: ['ARIS-6', 'ARIS-8'] · ревизия плана 3
- после: [{"key": "ARIS-6", "status": "review", "priority": "high", "due": "2026-11-19", "version": 2, "start": "2026-11-10", "end": "2026-11-20"}, {"key": "ARIS-8", "status": "in_progress", "priority": "high", "due": null, "version": 2, "start": "2026-11-20", "end": "2026-11-26"}, {"key": "ARIS-14", "status": "todo", "priority": "critical", "due": "2026-12-10", "version": 1, "start": "2026-12-10", "end": "2026-12-10"}] {"tasks": 19, "plan_revision": 3, "audit": 66}
- аудит ARIS-6: {"operation": "task_updated", "changes": {"proposal_id": "WCP-6507cb46316f2461", "status": {"after": "review", "before": "in_progress"}}, "correlation_id": "WCP-6507cb46316f2461"}

### Устаревший change-set

- после ручной правки другой задачи: state = stale ['plan_changed'] · apply → 409 proposal_stale {'reason': 'plan_changed'} · состояние не изменилось: True

### Анализ проекта

- ответ: Просроченных задач в RAG: 1 [F1] — RAG-2.
- факт: {"ref": "F1", "source": "skh_work", "operation": "get_project_schedule", "label": "План проекта RAG", "value": 8, "effective_filters": {"project": "RAG", "plan_revision": 1}}
