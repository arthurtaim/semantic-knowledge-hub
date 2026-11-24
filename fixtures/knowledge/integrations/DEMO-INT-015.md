---
id: DEMO-INT-015
title: "Consumer API: контракт выдачи"
type: integration
status: approved
owner: demo-integration-team
version: "1.4"
synthetic: true
reviewed_at: 2026-10-20
tags: [api, consumer-api, контракт, contract, process-overview, dependency-graph, rate-limit, лимит-запросов, integration, интеграция]
aliases: ["API потребителей", "контракт выдачи данных", "consumer contract", "API Process Overview"]
summary: "Синтетический контракт выдачи датасетов Process Overview и Dependency Graph потребителям: GET /demo/v1/process-overview?process_id=PRC-000417, страница 100 записей, не более 60 запросов в минуту на потребителя."
related_ids: [DEMO-INT-016, DEMO-SEM-007, DEMO-INT-014, DEMO-GOV-010]
relations:
  consumes: [DEMO-SEM-009, DEMO-SEM-010]
---

# Consumer API: контракт выдачи

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ задаёт учебный контракт, по которому потребители получают готовые датасеты семантического слоя:
Process Overview и Dependency Graph. Контракт синтетический: адреса ниже не являются реальными конечными
точками, и демо-приложение их не обслуживает. Документ нужен для упражнений по поиску, lineage и
правилам совместимости.

## Источник и получатель

- **Источник**: датасеты Process Overview (DEMO-SEM-009) и Dependency Graph (DEMO-SEM-010).
- **Получатель**: потребители учебной модели (отчёты, другие сервисы) с ролью не ниже `demo-reader`.

## Входные данные (Inputs)

| Запрос | Назначение |
|---|---|
| `GET /demo/v1/process-overview?process_id=PRC-000417` | один процесс по `process_id` |
| `GET /demo/v1/process-overview` | список процессов постранично |
| `GET /demo/v1/dependency-graph?node_id=<node_id>` | рёбра Dependency Graph для узла |

Параметр `process_id` проверяется по контракту атрибута Process ID: `PRC-` и 6 цифр. Для следующей
страницы передаётся `page_token` из предыдущего ответа.

## Выходные данные (Outputs)

Ответ `process-overview` содержит поля датасета Process Overview без переименований: `process_id`,
`process_name`, `owner_role`, `source_system`, `source_changed_at`, `completeness_score`, `lineage_ref`.
Ответ `dependency-graph` содержит поля Dependency Graph: `node_id`, `depends_on_node_id`,
`dependency_type`, `source_system`. Оба ответа содержат `page_size` и `next_page_token`.

## Правила преобразования (Transformation Rules)

1. API ничего не вычисляет и не обогащает: значения выдаются такими, какими они записаны в датасете.
2. Имена полей ответа совпадают с именами атрибутов датасета.
3. Время выдаётся в UTC в формате ISO 8601.
4. Записи списка упорядочены по `process_id` (для Dependency Graph — по `node_id`, затем по
   `depends_on_node_id`).

## Ограничения (Constraints)

- Размер страницы фиксирован: 100 записей; запросить больше нельзя.
- Лимит — 60 запросов в минуту на потребителя, общий для обоих ресурсов.
- Минимальная роль доступа — `demo-reader` по правилам ограничений доступа демо-среды.
- API отдаёт только утверждённые данные датасетов; оценку актуальности потребитель делает сам по
  `source_changed_at`.

## Ошибки и обработка (Error Cases)

| HTTP | Код | Когда |
|---|---|---|
| 400 | `invalid_process_id` | `process_id` не соответствует формату `PRC-` и 6 цифр |
| 404 | `process_not_found` | процесса нет в датасете |
| 429 | `rate_limited` | превышен лимит 60 запросов в минуту; заголовок `Retry-After` содержит число секунд |

После ответа 429 потребитель ждёт указанное время и не повторяет запрос раньше.

## Версия и статус

Версия контракта и документа — 1.4, статус approved, путь `/demo/v1/`. Изменения контракта
классифицируются по правилам совместимости DEMO-INT-016: добавление поля — MINOR, удаление или
переименование поля — MAJOR с переходом на `/demo/v2/`.

## Пример

Запрос `GET /demo/v1/process-overview?process_id=PRC-000417` возвращает (значения вымышленные):

```json
{
  "items": [
    {
      "process_id": "PRC-000417",
      "process_name": "Согласование заявки (демо)",
      "owner_role": "Руководитель направления согласований (демо)",
      "source_system": "SYS-ARIS",
      "source_changed_at": "2026-10-14T06:12:00Z",
      "completeness_score": 100.0,
      "lineage_ref": "LIN-ARIS-PRC-000417"
    }
  ],
  "page_size": 100,
  "next_page_token": null
}
```

`completeness_score` выдаётся в процентах, от 0.0 до 100.0, как в датасете. Запрос `GET /demo/v1/process-overview?process_id=PRC-417`
вернёт 400 `invalid_process_id`, потому что номер не дополнен до 6 цифр.

## Связанные документы

- DEMO-SEM-009 — датасет Process Overview, основной источник ответа (`consumes`).
- DEMO-SEM-010 — датасет Dependency Graph для ресурса `dependency-graph` (`consumes`).
- DEMO-INT-016 — правила совместимости схем, по которым версионируется контракт (ссылка).
- DEMO-SEM-007 — контракт атрибута Process ID, по которому проверяется параметр `process_id` (ссылка).
- DEMO-INT-014 — схема lineage, объясняющая значение поля `lineage_ref` (ссылка).
- DEMO-GOV-010 — ограничения доступа в демо-среде и роль `demo-reader` (ссылка).
