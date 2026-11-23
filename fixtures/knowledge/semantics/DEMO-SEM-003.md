---
id: DEMO-SEM-003
title: "Логическая модель: BusinessObject"
type: domain
status: approved
owner: demo-semantic-team
version: "1.2"
synthetic: true
reviewed_at: 2026-09-25
tags: [logical-model, логическая-модель, businessobject, бизнес-объект, object, объект, entity, сущность, catia, erp, assembly, сборка]
aliases: ["BusinessObject", "Бизнес-объект (логическая сущность)", "Logical model BusinessObject", "логическая модель объекта"]
summary: "Логическая сущность BusinessObject для деталей и сборок CATIA и элементов справочников ERP: идентификатор object_id с префиксом системы (SYS-CATIA:CP-104233), атрибуты source_object_id, object_name, object_class, revision, material_class, parent_object_id, source_changed_at; основа датасета Dependency Graph."
related_ids: [DEMO-SEM-002, DEMO-SEM-012]
relations:
  derived_from: [DEMO-SRC-003, DEMO-SRC-005]
---

# Логическая модель: BusinessObject

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ задаёт логическую сущность BusinessObject — предмет, с которым работают бизнес-процессы: деталь
или сборка из условной модели изделий CATIA (`SYS-CATIA`) либо элемент справочника условного ERP
(`SYS-ERP`), например материал. Модель объединяет два источника в одну сущность с общим набором атрибутов,
но не сливает записи разных источников между собой.

## Определение

BusinessObject — объект, идентифицируемый атрибутом `object_id`: код системы-источника, двоеточие и
идентификатор объекта в этой системе, например `SYS-CATIA:CP-104233`. В отличие от BusinessProcess, у
объекта в демо-модели **нет суррогатного номера** вроде Process ID: идентификатор детерминированно
строится из ключа источника. Префикс системы гарантирует, что одинаковые ключи в CATIA и ERP дают разные
объекты, а одинаковые названия тем более не означают одну сущность.

## Атрибуты

| Атрибут | Тип | Обязательный | Описание | Источник |
|---|---|---|---|---|
| `object_id` | string | да | Код системы + `:` + ключ в источнике, например `SYS-CATIA:CP-104233` | CATIA: `catia_part_number`; ERP: `erp_ref_type` + `erp_ref_code` |
| `source_object_id` | string | да | Ключ объекта в источнике без префикса, например `CP-104233` | Те же поля источника |
| `source_system` | string | да | Код системы-источника | Константа потока: `SYS-CATIA` или `SYS-ERP` |
| `object_class` | enum | да | `part`, `assembly`, `material`, `reference_item` | CATIA: `assembly`, если на объект ссылаются через `assembly_ref`, иначе `part`; ERP: `material` для справочника материалов, иначе `reference_item` |
| `object_name` | string | нет | Нормализованное название объекта (DEMO-SEM-008) | ERP: `erp_ref_name`; в выгрузке CATIA названий нет — название может задать стюард данных |
| `source_changed_at` | datetime (UTC) | да | Момент последнего изменения объекта | ERP: `erp_changed_at`; CATIA: время ежедневного снимка, в котором появилась текущая ревизия |
| `revision` | string | нет | Буква актуальной ревизии (A–Z); только для CATIA | `revision_letter` |
| `material_class` | string | нет | Класс материала | CATIA: `material_class` из закрытого списка источника (`MC-STEEL`, `MC-ALU`, `MC-COMPOSITE`, `MC-OTHER`); ERP: колонка, назначенная правилом маппинга ERP |
| `parent_object_id` | string | нет | `object_id` сборки, в которую входит объект | `SYS-CATIA:` + `assembly_ref`; пусто у изделий верхнего уровня |

## Связи с другими сущностями

- **BusinessObject ← BusinessProcess** («используется процессом», многие-ко-многим): обратная сторона связи
  из логической модели BusinessProcess (DEMO-SEM-002).
- **BusinessObject → BusinessObject** («входит в сборку»): `parent_object_id` указывает на сборку. Эти пары
  образуют рёбра датасета Dependency Graph (DEMO-SEM-010) с `dependency_type = assembly`; датасет объявляет
  связь `derived_from` на эту модель.
- **BusinessObject → справочники**: значение `material_class` не перекодируется — закрытый список ведёт
  источник, а не MDM.

## Ограничения

1. `object_id` уникален и неизменен; новая ревизия детали CATIA не меняет ни `catia_part_number`, ни
   `object_id`.
2. В модели хранится только **последняя ревизия** изделия CATIA. Поэтому `revision` — атрибут объекта, а
   не часть ключа.
3. `revision` заполняется только для `SYS-CATIA`; для ERP он пуст.
4. У объекта не более одной родительской сборки; циклы по `parent_object_id` запрещены — объект не может
   прямо или косвенно входить сам в себя.
5. `parent_object_id` ссылается на объект того же источника: сборка CATIA не может включать элемент ERP.
6. Объекты CATIA и ERP с совпадающими названиями автоматически не объединяются; такие пары, как и
   совпадения названий объекта и процесса ARIS, разбираются по правилам DEMO-SEM-012.

## Пример

Деталь и сборка CATIA (значения вымышленные):

| Атрибут | Деталь | Сборка |
|---|---|---|
| `object_id` | `SYS-CATIA:CP-104233` | `SYS-CATIA:CP-100010` |
| `source_object_id` | `CP-104233` | `CP-100010` |
| `object_class` | `part` | `assembly` |
| `object_name` | Кронштейн крепления (демо) — задан стюардом | Сборка узла крепления (демо) — задан стюардом |
| `revision` | `C` | `B` |
| `material_class` | `MC-ALU` | `MC-STEEL` |
| `parent_object_id` | `SYS-CATIA:CP-100010` | — (изделие верхнего уровня) |

Элемент справочника ERP: `object_id` = `SYS-ERP:MAT-00731`, `object_class` = `material`, `object_name` — из
`erp_ref_name`. Даже если стюард даст детали CATIA то же название, это будет отдельный BusinessObject.

Название сборки «Сборка узла крепления (демо)» совпадает с названием процесса в ARIS — это классический
омоним между ARIS и CATIA, разобранный в DEMO-SEM-012.

## Связанные документы

- DEMO-SRC-003 — `derived_from`: модель выведена из условной модели метаданных изделий CATIA (поля
  `catia_part_number`, `assembly_ref`, `revision_letter`, `material_class`).
- DEMO-SRC-005 — `derived_from`: элементы справочников ERP (`erp_ref_type`, `erp_ref_code`,
  `erp_ref_name`, `erp_changed_at`) дают объекты классов `material` и `reference_item`.
- DEMO-SEM-002 — логическая модель BusinessProcess: другая сторона связи «процесс использует объект».
- DEMO-SEM-012 — правила разрешения неоднозначных сущностей: совпадающие названия объектов CATIA, ERP и
  процессов ARIS.
