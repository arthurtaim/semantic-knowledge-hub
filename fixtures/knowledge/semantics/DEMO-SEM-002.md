---
id: DEMO-SEM-002
title: "Логическая модель: BusinessProcess"
type: domain
status: approved
owner: demo-semantic-team
version: "1.4"
synthetic: true
reviewed_at: 2026-09-18
tags: [logical-model, логическая-модель, businessprocess, бизнес-процесс, process, процесс, entity, сущность, aris, attributes, атрибуты]
aliases: ["BusinessProcess", "Бизнес-процесс (логическая сущность)", "Logical model BusinessProcess", "логическая модель процесса"]
summary: "Логическая сущность BusinessProcess: атрибуты process_id, process_name, process_path, owner_role, source_changed_at, lifecycle_state и source_system, их смысл, обязательность и происхождение из выгрузки ARIS; без типов колонок и ключей хранения."
related_ids: [DEMO-SEM-003, DEMO-SEM-007, DEMO-SEM-008]
relations:
  derived_from: [DEMO-SRC-002]
---

# Логическая модель: BusinessProcess

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ задаёт логическую сущность BusinessProcess — бизнес-процесс в том виде, в каком его видят
потребители семантического слоя. Логическая модель описывает смысл атрибутов, их обязательность и
источник значения, но не типы колонок, индексы и технические поля: это предмет физической модели
`sl_process_metadata` (DEMO-SEM-005). Модель выведена из условной модели процессных метаданных ARIS
(`SYS-ARIS`).

## Определение

BusinessProcess — устойчиво идентифицируемая последовательность работ, описанная в процессной модели ARIS и
зарегистрированная в семантическом слое с собственным Process ID. Один объект ARIS (`aris_object_guid`)
соответствует ровно одному BusinessProcess. Название, путь в иерархии и роль-владелец могут меняться,
идентификатор — никогда.

## Атрибуты

| Атрибут | Тип | Обязательный | Описание | Источник |
|---|---|---|---|---|
| `process_id` | string | да | Устойчивый идентификатор по контракту Process ID: `PRC-` и 6 цифр | `aris_object_guid` через таблицу соответствия `MAP_ARIS_PROCESS` |
| `process_name` | string | да | Нормализованное название процесса для показа | `aris_object_name` после нормализации (DEMO-SEM-008) |
| `process_path` | string | нет | Путь в иерархии модели, сегменты разделены `/`, не глубже 7 уровней | `aris_model_path` |
| `owner_role` | string | да | Роль-владелец процесса; значение должно существовать в справочнике `DICT_OWNER_ROLE` | `aris_owner_role` без изменений |
| `source_changed_at` | datetime (UTC) | да | Момент последнего изменения объекта в ARIS | `aris_last_change` |
| `lifecycle_state` | enum | да | Состояние жизненного цикла: `active` или `draft` | `aris_status`: `released` → `active`, `in_work` → `draft` |
| `source_system` | string | да | Код системы-источника | Константа `SYS-ARIS`, присваивается при загрузке, не поле выгрузки |

Атрибут `owner_role` в логической модели — это **роль** в том виде, в каком её знают источник и каталог
(например, `process-owner-requests-demo`), а не имя человека и не внутренний код. Код роли из справочника
(`ROLE-014`) появляется только в физической модели.

## Связи с другими сущностями

- **BusinessProcess → BusinessObject** («использует», многие-ко-многим): процесс работает с объектами —
  изделиями, материалами, справочными позициями (DEMO-SEM-003). Связь логическая, в выгрузке ARIS её нет,
  её ведёт стюард данных.
- **BusinessProcess → BusinessProcess** (иерархия): родительский процесс определяется по `process_path`;
  отдельного атрибута родителя в логической модели нет.
- **BusinessProcess → справочник ролей**: значение `owner_role` должно существовать в `DICT_OWNER_ROLE`.
- Из BusinessProcess выведены физическая таблица `sl_process_metadata` (DEMO-SEM-005) и датасет
  Process Overview (DEMO-SEM-009); эти документы сами объявляют связь `derived_from` на эту модель.

## Ограничения

1. `process_id` подчиняется контракту [[DEMO-SEM-007]]: формат `PRC-` и 6 цифр, неизменяемый, никогда не
   используется повторно. Переименование или перенос процесса в другую ветку модели не меняет `process_id`.
2. `process_name` не пуст после нормализации и не длиннее 255 символов.
3. Глубина `process_path` — не более 7 уровней (`ARIS_MAX_DEPTH = 7`).
4. Объекты со статусом ARIS `obsolete` в модель не попадают: такая запись отклоняется на входе, поэтому
   значения `obsolete` у `lifecycle_state` нет.
5. Обязательные атрибуты `process_id`, `process_name`, `owner_role` должны быть заполнены; запись без них
   не становится BusinessProcess.
6. Идентичность определяется только `process_id`. Совпадение названий двух процессов не делает их одной
   сущностью — см. правила для омонимов в [[DEMO-SEM-012]].

## Пример

| Атрибут | Значение |
|---|---|
| `process_id` | `PRC-000417` |
| `process_name` | Согласование заявки (демо) |
| `process_path` | Демо-модель/Заявки/Согласование |
| `owner_role` | `process-owner-requests-demo` |
| `source_changed_at` | 2026-10-14T06:12:00Z |
| `lifecycle_state` | `active` (в ARIS было `released`) |
| `source_system` | `SYS-ARIS` |

Если в ARIS тот же объект переименуют в «Согласование заявки клиента (демо)», изменятся `process_name` и
`source_changed_at`, а `process_id` останется `PRC-000417`.

## Связанные документы

- [[DEMO-SRC-002]] — `derived_from`: модель выведена из условной модели процессных метаданных ARIS; оттуда
  поля `aris_object_guid`, `aris_object_name`, `aris_model_path`, `aris_owner_role`, `aris_last_change`,
  `aris_status`.
- DEMO-SEM-003 — логическая модель BusinessObject: вторая сторона связи «процесс использует объект».
- DEMO-SEM-007 — контракт атрибута Process ID: формат и неизменяемость `process_id` (этот контракт
  ограничивает модель связью `constrains`).
- DEMO-SEM-008 — справочники и нормализация названий: правила для `process_name` и справочник
  `DICT_OWNER_ROLE`.
