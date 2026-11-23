---
id: DEMO-INT-005
title: "CATIA → Catalog: маппинг полей (демо)"
type: integration
status: approved
owner: demo-integration-team
version: "1.1"
synthetic: true
reviewed_at: 2026-09-18
tags: [catia, mapping, маппинг, сопоставление, catalog, dependency-graph, граф-зависимостей, assembly, сборка, integration]
aliases: ["CATIA mapping", "CATIA field mapping", "сопоставление полей CATIA"]
summary: "Сопоставление полей CATIA с атрибутами BusinessObject и рёбрами датасета Dependency Graph: SYS-CATIA: + catia_part_number → node_id, SYS-CATIA: + assembly_ref → depends_on_node_id, dependency_type = assembly."
relations:
  depends_on: [DEMO-INT-004]
  maps_to: [DEMO-SEM-003]
  produces: [DEMO-SEM-010]
---

# CATIA → Catalog: маппинг полей (демо)

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ описывает, как строки суточной дельты CATIA, прошедшие поток CATIA → Catalog (DEMO-INT-004),
превращаются в атрибуты бизнес-объекта BusinessObject и в рёбра датасета Dependency Graph. Маппинг
(сопоставление полей) отвечает на вопрос «из какого поля CATIA взялось это значение в графе зависимостей» и не
содержит эвристик: каждое целевое значение либо выводится по правилу, либо не создаётся.

## Источник и получатель

Источник — строки `SYS-CATIA`, принятые потоком [[DEMO-INT-004]]. Получателей два:

- BusinessObject — состав атрибутов задан логической моделью [[DEMO-SEM-003]]; идентификатор объекта — код системы
  и ключ в источнике через двоеточие;
- датасет Dependency Graph (`DS-002`, [[DEMO-SEM-010]]) — рёбра с полями `node_id`, `depends_on_node_id`,
  `dependency_type`, `source_system`.

## Входные данные (Inputs)

Четыре поля CATIA: `catia_part_number`, `assembly_ref`, `revision_letter`, `material_class`, а также время
ежедневного запуска, в котором пришла строка. У изделия одна ссылка на родительскую сборку; у изделия верхнего
уровня `assembly_ref` пуст.

## Выходные данные (Outputs)

- Атрибуты BusinessObject: `object_id`, `source_object_id`, `parent_object_id`, `object_class`, `revision`,
  `material_class`, `source_system`, `source_changed_at`.
- Ребро Dependency Graph на каждое изделие с непустым `assembly_ref`.

## Правила преобразования (Transformation Rules)

| Поле CATIA | Цель | Правило |
|---|---|---|
| `catia_part_number` | BusinessObject `object_id`; Dependency Graph `node_id` | `SYS-CATIA:` + номер изделия |
| `catia_part_number` | BusinessObject `source_object_id` | номер изделия без префикса |
| `assembly_ref` | BusinessObject `parent_object_id`; Dependency Graph `depends_on_node_id` | `SYS-CATIA:` + номер сборки; при пустом значении ребро не создаётся |
| — | BusinessObject `object_class` | `assembly`, если на изделие ссылаются другие через `assembly_ref`, иначе `part` |
| `revision_letter` | BusinessObject `revision` | как есть; в граф не попадает |
| `material_class` | BusinessObject `material_class` | как есть, значение из закрытого списка источника |
| время запуска | BusinessObject `source_changed_at` | CATIA не передаёт время изменения, поэтому берётся время ежедневного снимка 02:30, в котором появилась текущая ревизия |
| — | `dependency_type` | константа `assembly` |
| — | `source_system` | константа `SYS-CATIA` |

Пояснения к правилам:

1. Каждое ребро графа получает `dependency_type = assembly`. Других типов зависимостей этот маппинг не создаёт.
2. Ребро направлено от изделия к сборке: «узел `node_id` входит в сборку `depends_on_node_id`». По рёбрам можно
   пройти и вниз (состав сборки), и вверх (в какие вышестоящие сборки входит изделие).
3. Идентификатор узла детерминирован: один и тот же номер изделия всегда даёт один и тот же `node_id`, поэтому
   повторная загрузка не порождает дублей, а новая ревизия не меняет узел.
4. Если у изделия сменилась сборка, прежнее ребро для этого `node_id` заменяется новым: у узла не бывает двух
   родительских сборок одновременно.
5. Названий в выгрузке CATIA нет, поэтому `object_name` этим маппингом не заполняется; его может задать стюард
   данных.

## Ограничения (Constraints)

- Ребро создаётся, только если оба конца есть среди объектов BusinessObject того же `source_system`.
- Петли и циклы недопустимы: ребро, которое замкнуло бы цепочку (A входит в B, B — в A), не записывается.
- Тройка (`node_id`, `depends_on_node_id`, `dependency_type`) уникальна.
- В граф и в BusinessObject попадает только последняя ревизия изделия; история ревизий хранится в активе каталога.

## Ошибки и обработка (Error Cases)

- **`E-MAP-001` (mapping not found)** — `assembly_ref` ссылается на неизвестное изделие. Атрибуты BusinessObject
  записываются, ребро не создаётся, причина `unknown_assembly` передаётся стюарду источника. Сборку никогда не
  подбирают по похожему номеру.
- **`E-VAL-002` (validation failed)** — ребро замыкает цикл или `node_id` совпадает с `depends_on_node_id`.
  Ребро отбрасывается без повторов и передаётся стюарду данных; существующие рёбра графа не меняются.

## Версия и статус

Версия 1.1, статус approved, дата проверки 2026-09-18. В 1.1 (MINOR) добавлено правило замены ребра при смене
сборки; имена полей Dependency Graph не менялись, поэтому изменение совместимое.

## Пример

Вход (из примера потока DEMO-INT-004), запуск 2026-09-17 в 02:30:

```yaml
- catia_part_number: "CP-104233"
  assembly_ref: "CP-100010"
  revision_letter: "C"
  material_class: "MC-ALU"
```

Выход:

```yaml
dependency_graph_edge:
  node_id: "SYS-CATIA:CP-104233"
  depends_on_node_id: "SYS-CATIA:CP-100010"
  dependency_type: assembly
  source_system: SYS-CATIA
business_object:
  object_id: "SYS-CATIA:CP-104233"
  source_object_id: "CP-104233"
  parent_object_id: "SYS-CATIA:CP-100010"
  object_class: part
  revision: "C"
  material_class: "MC-ALU"
  source_system: SYS-CATIA
  source_changed_at: "2026-09-17T02:30:00Z"   # время ежедневного снимка
```

Для изделия верхнего уровня `CP-100010` создаётся только BusinessObject `SYS-CATIA:CP-100010` с
`object_class = assembly`, ребра нет.

## Связанные документы

- **DEMO-INT-004** (`depends_on`) — поток CATIA → Catalog, который поставляет строки дельты для маппинга.
- **DEMO-SEM-003** (`maps_to`) — логическая модель BusinessObject: целевые атрибуты `object_id`,
  `source_object_id`, `parent_object_id`, `object_class`, `revision`, `material_class`.
- **DEMO-SEM-010** (`produces`) — датасет Dependency Graph: маппинг создаёт его рёбра с
  `dependency_type = assembly`.
