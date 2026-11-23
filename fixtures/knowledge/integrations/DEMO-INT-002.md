---
id: DEMO-INT-002
title: "ARIS → Catalog: маппинг полей (демо)"
type: integration
status: approved
owner: demo-integration-team
version: "1.3"
synthetic: true
reviewed_at: 2026-10-15
tags: [aris, catalog, mapping, маппинг, сопоставление, field-mapping, lookup, integration, интеграция, aris-catalog]
aliases: ["ARIS mapping", "ARIS field mapping", "сопоставление полей ARIS", "маппинг ARIS"]
summary: "Сопоставление шести полей экспорта ARIS с полями актива BusinessProcess в каталоге: aris_object_guid → process_id через таблицу MAP_ARIS_PROCESS, перевод aris_status в lifecycle_state."
related_ids: [DEMO-SEM-007, DEMO-GOV-006, DEMO-SEM-008]
relations:
  depends_on: [DEMO-INT-001]
  maps_to: [DEMO-SEM-002]
---

# ARIS → Catalog: маппинг полей (демо)

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ фиксирует, как каждое поле экспорта ARIS превращается в поле актива BusinessProcess в Data Catalog в
рамках инкрементального потока [[DEMO-INT-001]]. Главное правило — идентификатор процесса `process_id` берётся из
таблицы соответствия `MAP_ARIS_PROCESS` по GUID объекта ARIS, а не вычисляется. Маппинг (mapping, сопоставление полей) детерминирован: одно и то
же входное значение всегда даёт один и тот же результат. Если соответствие не найдено, запись отклоняется —
маппинг никогда не подбирает значение по похожему названию и не придумывает идентификатор.

## Источник и получатель

Источник — запись экспорта `SYS-ARIS`, прошедшая валидацию. Получатель — актив класса BusinessProcess в
`SYS-CAT`; состав и смысл целевых полей заданы логической моделью [[DEMO-SEM-002]]. Маппинг выполняется внутри
потока DEMO-INT-001 после проверок валидации и до записи в каталог.

## Входные данные (Inputs)

- Шесть полей записи ARIS: `aris_object_guid`, `aris_object_name`, `aris_model_path`, `aris_owner_role`,
  `aris_last_change`, `aris_status`.
- Таблица соответствия (lookup table) `MAP_ARIS_PROCESS` с колонками `aris_object_guid`, `process_id`,
  `registered_at`, `mapping_state` (`active` или `retired`). Таблицу ведёт владелец источника ARIS (роль
  `src-owner-aris`); поток её только читает.

## Выходные данные (Outputs)

Поля актива BusinessProcess: `process_id`, `process_name`, `process_path`, `owner_role`, `source_changed_at`,
`lifecycle_state`, а также техническое поле `source_system` со значением `SYS-ARIS`. Для отклонённых записей
вместо актива формируется строка отчёта запуска с кодом ошибки.

## Правила преобразования (Transformation Rules)

| Поле ARIS | Поле каталога | Правило |
|---|---|---|
| `aris_object_guid` | `process_id` | поиск строки в `MAP_ARIS_PROCESS` с `mapping_state = active`; результат — номер вида `PRC-` + 6 цифр |
| `aris_object_name` | `process_name` | нормализация названия по правилам справочников (DEMO-SEM-008) |
| `aris_model_path` | `process_path` | путь переносится как есть, разделитель уровней `/`, пробелы по краям сегментов удаляются |
| `aris_owner_role` | `owner_role` | значение роли переносится без изменений |
| `aris_last_change` | `source_changed_at` | перевод в UTC, формат ISO 8601 |
| `aris_status` | `lifecycle_state` | `released` → `active`; `in_work` → `draft`; `obsolete` → запись отклоняется |
| — | `source_system` | константа `SYS-ARIS` |

Дополнительные правила:

1. `process_id` никогда не вычисляется из GUID или из названия — только берётся из `MAP_ARIS_PROCESS`.
   Контракт атрибута (DEMO-SEM-007): формат `^PRC-\d{6}$`, значение неизменяемо и не переиспользуется.
2. Если объект в ARIS пересоздан и получил новый GUID, владелец источника связывает новый GUID с прежним
   `process_id`, а старую строку переводит в `retired`. Номер процесса при этом не меняется.
3. Одному `process_id` соответствует не более одной строки со статусом `active`, и наоборот.
4. Значение `aris_status` вне трёх перечисленных не переводится: запись отклоняется с кодом `E-MAP-001`.
5. Нормализация названия выполняется только по правилам [[DEMO-SEM-008]]; маппинг их не переопределяет.

## Ограничения (Constraints)

- Ссылочная целостность (DEMO-GOV-006): каждый `process_id`, записываемый в каталог, обязан иметь строку
  `mapping_state = active` в `MAP_ARIS_PROCESS`. Актив без такой строки в каталог не попадает.
- Маппинг не создаёт строк в `MAP_ARIS_PROCESS` и не выдаёт новые номера `PRC-`: регистрация нового процесса —
  ручное действие владельца источника (`src-owner-aris`).
- Маппинг не проверяет полноту и глубину иерархии — это зона валидационных ограничений, которые
  накладываются на этот маппинг документом DEMO-INT-003.

## Ошибки и обработка (Error Cases)

- **`E-MAP-001` (mapping not found)** — GUID нет в `MAP_ARIS_PROCESS`, строка есть только в состоянии
  `retired` или значение статуса неизвестно. Запись не пишется в каталог и попадает в отчёт запуска. По общей
  политике повторов она повторяется до 5 раз — таблица соответствий может пополниться между попытками, — а
  затем уходит в `dlq.metadata.v1`. Разбор отклонённых записей ведёт стюард источника (`src-steward-aris`).
- **Неоднозначное соответствие** — для одного GUID найдено две активные строки. Запись отклоняется с кодом
  `E-MAP-001` и причиной `ambiguous_mapping`; поток не выбирает одну из строк сам.
- **Статус `obsolete`** — запись отклоняется ещё на валидации; правило в таблице приведено для полноты
  перевода статусов.

## Версия и статус

Версия 1.3, статус approved, дата проверки 2026-10-15. Изменения версии 1.3 (MINOR, совместимое): добавлено
явное правило для неизвестных значений статуса и причина `ambiguous_mapping`. Версия 1.2 ввела перевод
`aris_last_change` в UTC. Ни одно из изменений не меняло имена целевых полей, поэтому MAJOR не повышался.

## Пример

```yaml
# вход: запись ARIS (лишние пробелы в названии оставлены для примера нормализации)
aris_object_guid: "guid-demo-0417"
aris_object_name: "  Согласование   заявки (демо) "
aris_model_path: "Демо-модель/Заявки/Согласование"
aris_owner_role: "process-owner-requests-demo"
aris_last_change: "2026-10-14T09:12:00+03:00"
aris_status: released

# строка таблицы MAP_ARIS_PROCESS
# guid-demo-0417 → PRC-000417, mapping_state: active

# выход: актив BusinessProcess в каталоге
process_id: PRC-000417
process_name: "Согласование заявки (демо)"
process_path: "Демо-модель/Заявки/Согласование"
owner_role: "process-owner-requests-demo"
source_changed_at: "2026-10-14T06:12:00Z"
lifecycle_state: active
source_system: SYS-ARIS
```

Время со смещением `+03:00` переведено в UTC, поэтому `source_changed_at` = 06:12 UTC. Путь содержит 3 уровня —
в пределах `ARIS_MAX_DEPTH = 7`. Та же запись со статусом `in_work` получила бы `lifecycle_state: draft`, со
статусом `obsolete` — была бы отклонена.

## Связанные документы

- **DEMO-INT-001** (`depends_on`) — поток ARIS → Catalog, внутри которого выполняется маппинг; без него у
  маппинга нет входных записей.
- **DEMO-SEM-002** (`maps_to`) — логическая модель BusinessProcess: целевые поля `process_id`, `process_name`,
  `process_path`, `owner_role`, `source_changed_at`, `lifecycle_state`.
- **DEMO-SEM-007** (ссылка) — контракт атрибута Process ID: формат `PRC-` + 6 цифр, неизменяемость.
- **DEMO-GOV-006** (ссылка) — правила ссылочной целостности, которые ограничивают этот маппинг (обратное ребро
  `constrains` объявлено в DEMO-GOV-006).
- **DEMO-SEM-008** (ссылка) — справочники и нормализация названий для `process_name`.
- Входящее ребро: DEMO-INT-003 накладывает на маппинг валидационные ограничения (`constrains`).
