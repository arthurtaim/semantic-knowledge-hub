---
id: DEMO-SEM-004
title: "Логическая модель: Dataset"
type: domain
status: approved
owner: demo-semantic-team
version: "1.3"
synthetic: true
reviewed_at: 2026-10-02
updated_at: 2026-10-02
tags: [logical-model, логическая-модель, dataset, датасет, набор-данных, metadata, метаданные, specification, спецификация, entity, сущность]
aliases: ["Dataset entity", "Сущность Dataset", "модель описания датасета", "Logical model Dataset"]
summary: "Логическая сущность Dataset: какими атрибутами описывается любой датасет семантического слоя (dataset_id вида DS-001, источники, бизнес-сущности, атрибуты, правила качества, политика обновления, доступ, версия шаблона) и как они соответствуют разделам шаблона Dataset Specification."
related_ids: [DEMO-SEM-009, DEMO-SEM-010, DEMO-SEM-011, DEMO-PROC-007]
---

# Логическая модель: Dataset

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ задаёт логическую сущность Dataset — метаописание датасета семантического слоя. Это не сами данные,
а обязательный «паспорт»: откуда датасет собирается, из каких бизнес-сущностей, какие у него атрибуты,
правила качества, обновление и доступ. Все датасеты группы (Process Overview, Dependency Graph, Source
Coverage) описаны по этой модели и объявляют на неё связь `depends_on`.

## Определение

Dataset — именованный набор данных для потребителей, построенный из логических сущностей (BusinessProcess,
BusinessObject) или из реестров семантического слоя. Датасет идентифицируется `dataset_id` формата `DS-` и
3 цифры. Текстовое описание датасета пишется по шаблону Dataset Specification; каждый раздел шаблона
соответствует атрибуту этой сущности. Сам машиночитаемый шаблон хранится в реестре шаблонов приложения, а
DEMO-PROC-007 его описывает.

## Атрибуты

Колонка «Источник» указывает раздел шаблона Dataset Specification v1, из которого берётся значение.

| Атрибут | Тип | Обязательный | Описание | Источник |
|---|---|---|---|---|
| `dataset_id` | string | да | Идентификатор `DS-` и 3 цифры, не используется повторно | Присваивает команда семантического слоя |
| `dataset_name` | string | да | Имя датасета, например Process Overview | Overview |
| `description` | text | да | Назначение и потребители | Overview |
| `owner_team` | string | да | Команда-владелец, для демо — `demo-semantic-team` | Overview |
| `source_systems` | list | да | Коды систем, например `SYS-ARIS` | Source Systems |
| `business_entities` | list | да | Логические сущности, из которых строится датасет | Business Entities |
| `attributes` | list | да | Атрибуты: имя, тип, обязательность, описание, источник | Attributes |
| `mapping_rules` | text | нет | Правила вычисления производных атрибутов | Mapping Rules |
| `quality_rules` | list | да | Пороги полноты, актуальности и другие проверки | Data Quality |
| `refresh_policy` | text | да | Расписание и способ обновления (инкремент или полная пересборка) | Refresh Policy |
| `access_restrictions` | text | да | Кто читает и кто меняет описание | Access Restrictions |
| `related_docs` | list | нет | Идентификаторы связанных документов | Related Docs |
| `spec_template_version` | integer | да | Версия шаблона Dataset Specification, по которой написано описание | Фиксируется при создании описания |

## Связи с другими сущностями

- **Dataset → BusinessProcess / BusinessObject** («строится из»): через `business_entities`.
- **Dataset → Dataset Specification** («описан по шаблону»): через `spec_template_version`.
- **Dataset → потребитель**: датасеты выдаются через Consumer API; контракт выдачи — отдельный документ
  интеграционной группы.

Зарегистрированные датасеты:

| `dataset_id` | `dataset_name` | Документ |
|---|---|---|
| `DS-001` | Process Overview | DEMO-SEM-009 |
| `DS-002` | Dependency Graph | DEMO-SEM-010 |
| `DS-003` | Source Coverage | DEMO-SEM-011 |

## Ограничения

1. `business_entities` не пуст: датасет без логической сущности или реестра-источника не регистрируется.
2. Атрибуты датасета ссылаются на **логические** атрибуты, а не на физические колонки: в описании датасета
   пишется `owner_role`, а не `owner_role_code`.
3. `quality_rules` по умолчанию наследуют общие пороги (полнота 95 %, актуальность 24 ч для метаданных
   каталога). Датасет может только ужесточить порог для своей области; ослабление требует решения по
   правилам управления.
4. `spec_template_version` не меняется сама: старое описание остаётся на той версии шаблона, по которой
   создано, переход на новую версию — отдельное изменение с ревью.
5. `dataset_id` не переиспользуется даже после вывода датасета из эксплуатации.
6. SLA в модели Dataset не предусмотрен; ни у одного демо-датасета SLA не определён.

## Пример

Паспорт `DS-001` (сокращённо):

```yaml
dataset_id: DS-001
dataset_name: Process Overview
owner_team: demo-semantic-team
source_systems: [SYS-ARIS]
business_entities: [BusinessProcess]
quality_rules:
  - completeness >= 98 % для process_id, process_name, owner_role
  - freshness <= 12 h
refresh_policy: инкремент после каждого запуска ARIS → Catalog (каждые 6 ч)
spec_template_version: 1
```

## Связанные документы

- DEMO-SEM-009 — датасет Process Overview (`DS-001`), описан по этой модели.
- DEMO-SEM-010 — датасет Dependency Graph (`DS-002`), описан по этой модели.
- DEMO-SEM-011 — датасет Source Coverage (`DS-003`), описан по этой модели.
- DEMO-PROC-007 — описание шаблона Dataset Specification: разделы шаблона соответствуют атрибутам этой
  сущности (шаблон, в свою очередь, объявляет, что описывает эту модель).
