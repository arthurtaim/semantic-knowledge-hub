---
id: DEMO-SEM-005
title: "Физическая модель: ProcessMetadataTable"
type: domain
status: approved
owner: demo-semantic-team
version: "1.1"
synthetic: true
reviewed_at: 2026-09-30
tags: [physical-model, физическая-модель, table, таблица, columns, колонки, processmetadatatable, sl_process_metadata, process, процесс, ddl]
aliases: ["ProcessMetadataTable", "sl_process_metadata", "Физическая таблица метаданных процессов", "Physical model ProcessMetadataTable"]
summary: "Физическая таблица sl_process_metadata (модель ProcessMetadataTable), реализующая логическую сущность BusinessProcess: колонки и типы, ключи и проверки (ck_process_id_format, ck_path_depth), технические колонки source_object_id, record_hash, load_batch_id, loaded_at."
related_ids: [DEMO-SEM-006, DEMO-SEM-007]
relations:
  derived_from: [DEMO-SEM-002]
---

# Физическая модель: ProcessMetadataTable

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ описывает физическую модель ProcessMetadataTable — таблицу `semantic_demo.sl_process_metadata`,
в которой хранится текущее состояние бизнес-процессов. Это реализация логической сущности BusinessProcess
(DEMO-SEM-002): здесь заданы имена колонок, типы, ключи, проверки и технические колонки. Смысл атрибутов
здесь не переопределяется — он задан логической моделью.

## Определение

Одна строка таблицы — один BusinessProcess в его текущем состоянии. Историю изменений таблица не хранит:
при изменении строки старые значения перезаписываются. Имена колонок похожи на имена логических атрибутов,
но **не совпадают с ними намеренно**: колонка `owner_role_code` хранит код роли, а логический атрибут
`owner_role` — название роли; колонка `src_changed_ts` хранит время в UTC, а логический атрибут называется
`source_changed_at`.

## Атрибуты

| Колонка | Тип | Обязательный | Описание | Источник |
|---|---|---|---|---|
| `process_id` | VARCHAR(10) | да (PK) | Process ID, например `PRC-000417` | Логический `process_id` |
| `process_name` | VARCHAR(255) | да | Нормализованное название для показа | Логический `process_name` |
| `process_name_key` | VARCHAR(255) | да | Ключ сравнения названия (нижний регистр, без пунктуации) | Вычисляется из `process_name` |
| `process_path` | VARCHAR(1000) | нет | Путь в иерархии модели | Логический `process_path` |
| `path_depth` | SMALLINT | нет | Число уровней пути, от 1 до 7; пусто, если путь пуст | Вычисляется из `process_path` |
| `owner_role_code` | VARCHAR(8) | да | Код роли-владельца, например `ROLE-014` | Логический `owner_role` через `DICT_OWNER_ROLE` |
| `lifecycle_code` | CHAR(1) | да | `A` — active, `D` — draft | Логический `lifecycle_state` |
| `source_system_code` | VARCHAR(12) | да | Код системы, всегда `SYS-ARIS` | Логический `source_system` |
| `src_changed_ts` | TIMESTAMP (UTC) | да | Время последнего изменения в ARIS | Логический `source_changed_at` |
| `source_object_id` | VARCHAR(64) | да | Исходный `aris_object_guid` | Технический, из потока загрузки |
| `record_hash` | CHAR(64) | да | SHA-256 от бизнес-колонок; строка без изменений не перезаписывается | Технический |
| `load_batch_id` | VARCHAR(40) | да | Идентификатор пакета загрузки | Технический |
| `loaded_at` | TIMESTAMP (UTC) | да | Время записи строки в таблицу | Технический |

Последние четыре колонки — технические: у них нет логического атрибута, и в датасеты они не выдаются.
`loaded_at` нельзя путать с `src_changed_ts`: первое — когда строку записали, второе — когда процесс
изменили в источнике.

## Связи с другими сущностями

- `owner_role_code` — внешний ключ `fk_owner_role` на `semantic_demo.dict_owner_role.role_code`
  (физическая копия справочника `DICT_OWNER_ROLE`).
- (`source_system_code`, `source_object_id`) — уникальная пара `uq_process_source`; на неё опирается ключ
  идемпотентности загрузки `source_system + source_object_id + source_changed_at`.
- Связь процесса с объектами (BusinessObject) хранится в отдельной таблице и в этом документе не
  описывается.

## Ограничения

1. `PRIMARY KEY (process_id)`.
2. `ck_process_id_format`: значение `process_id` соответствует `^PRC-\d{6}$` — физическая реализация
   контракта DEMO-SEM-007.
3. `ck_path_depth`: `path_depth` пусто или от 1 до 7 включительно.
4. `ck_lifecycle_code`: `lifecycle_code` только `A` или `D`.
5. `UNIQUE (source_system_code, source_object_id)` — `uq_process_source`.
6. Индекс `ix_process_name_key` по `process_name_key` для поиска омонимов и дубликатов названий.
7. Все временные колонки хранятся в UTC с точностью до секунды.
8. Обновление строки разрешено только при изменении `record_hash`; `process_id` в существующей строке не
   обновляется никогда.

## Пример

Строка для процесса из логической модели:

| Колонка | Значение |
|---|---|
| `process_id` | `PRC-000417` |
| `process_name` | Согласование заявки (демо) |
| `process_name_key` | `согласование заявки демо` |
| `process_path` | Демо-модель/Заявки/Согласование |
| `path_depth` | 3 |
| `owner_role_code` | `ROLE-014` |
| `lifecycle_code` | `A` |
| `source_system_code` | `SYS-ARIS` |
| `src_changed_ts` | 2026-10-14 06:12:00 UTC |
| `source_object_id` | `guid-demo-0417` |
| `load_batch_id` | `ARIS-B-0412` |

Тот же процесс в логической модели имеет `owner_role` = `process-owner-requests-demo` и
`lifecycle_state` = `active`; преобразование описано в маппинге DEMO-SEM-006.

## Связанные документы

- DEMO-SEM-002 — `derived_from`: таблица реализует логическую сущность BusinessProcess.
- DEMO-SEM-006 — маппинг логической и физической моделей: построчные правила «атрибут → колонка»
  (маппинг объявляет связь `maps_to` на этот документ).
- DEMO-SEM-007 — контракт Process ID: проверка `ck_process_id_format` реализует его формат (контракт
  объявляет, что ограничивает эту модель).
