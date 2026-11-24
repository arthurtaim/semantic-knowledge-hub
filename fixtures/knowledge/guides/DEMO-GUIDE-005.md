---
id: DEMO-GUIDE-005
title: "How to distinguish logical and physical models"
type: guide
status: approved
owner: demo-enablement-team
version: "1.0"
synthetic: true
reviewed_at: 2026-10-13
updated_at: 2026-10-13
tags: [guide, руководство, how-to, logical-model, логическая-модель, physical-model, физическая-модель, model, модель, mapping, маппинг, english]
aliases: ["logical vs physical model", "логическая и физическая модель", "BusinessProcess vs ProcessMetadataTable"]
summary: "English how-to guide: how to tell a logical model (the BusinessProcess entity) from a physical model (the ProcessMetadataTable table) and how to follow the mapping between them, e.g. owner_role vs owner_role_code."
related_ids: [DEMO-SEM-002, DEMO-SEM-005, DEMO-SEM-006, DEMO-SEM-007, DEMO-PROC-004]
---

# How to distinguish logical and physical models

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

> Synthetic demo document: it describes a fictional training model, not bank systems.

## When to use

Use this guide when you read a semantic-layer document and are not sure whether it describes *what the data
means* or *how the data is stored*: for example, when a reviewer asks whether `owner_role` or
`owner_role_code` is the "right" name, or when you prepare a logical model review.

Кратко по-русски: логическая модель (logical model) описывает смысл бизнес-сущности — здесь это
BusinessProcess; физическая модель (physical model) описывает таблицу хранения — здесь это
ProcessMetadataTable. Например, атрибут `owner_role` логической модели хранится в столбце `owner_role_code`
физической модели, а связь между ними задаёт маппинг (сопоставление полей).

## Step by step

1. **Check the document title and type.** In the demo catalog, logical models are titled «Логическая модель: …»
   (for example, [[DEMO-SEM-002]] *BusinessProcess*) and physical models «Физическая модель: …» (DEMO-SEM-005
   *ProcessMetadataTable*). Both use type `domain`, so the type alone is not enough.
2. **Look at the vocabulary.**
   - A **logical model** talks about *entities* and *attributes* with business meaning: `process_id`,
     `process_name`, `process_path`, `owner_role`, `source_changed_at`, `lifecycle_state`. It does not mention
     storage, indexes or partitions.
   - A **physical model** talks about *tables* and *columns*: column names, data types, keys, indexes and
     technical columns. Names may be adapted for storage, e.g. `owner_role_code` instead of `owner_role`.
3. **Follow the relations.** The physical model is `derived_from` the logical one: [[DEMO-SEM-005]] is derived from
   DEMO-SEM-002. The mapping document [[DEMO-SEM-006]] `maps_to` the physical model and `depends_on` the logical
   one. If a document has a `derived_from` edge to a logical entity and describes columns, it is physical.
4. **Find the mapping row.** For any attribute, open DEMO-SEM-006 and find the row that connects the logical
   attribute to the physical column. Never guess a column name from the attribute name.
5. **Check shared contracts.** Some rules apply to both levels. The Process ID contract (DEMO-SEM-007)
   constrains the logical attribute and the physical column alike: format `PRC-` followed by 6 digits
   (`^PRC-\d{6}$`), immutable, never reused.

| Question | Logical model (BusinessProcess) | Physical model (ProcessMetadataTable) |
|---|---|---|
| What does it describe? | Business meaning of a process | How process metadata is stored |
| Unit | Entity and attribute | Table and column |
| Owner role | `owner_role` | `owner_role_code` |
| Changes when | The business meaning changes | Storage design changes |
| Typical reader | Analyst, data steward | Data engineer |

## Example

A consumer sees `owner_role_code` in a physical table and `owner_role` in the Process Overview dataset and asks
whether these are two different facts.

1. `owner_role` appears in DEMO-SEM-002, which describes an entity — this is the logical attribute.
2. `owner_role_code` appears in DEMO-SEM-005, which describes a table — this is the physical column.
3. DEMO-SEM-006 contains the mapping `owner_role` → `owner_role_code`.

Answer: it is one fact on two levels of the model, not two facts. The record `PRC-000417` «Согласование
заявки (демо)» has a single owner role; the logical model names it `owner_role`, the table stores it in
`owner_role_code`.

## Common mistakes

- **Treating a column rename as a business change.** Renaming a physical column changes the physical model and
  the mapping only; the logical attribute and its meaning stay the same.
- **Adding storage details to the logical model.** Indexes, data types and technical columns belong to the
  physical model; a logical model that mentions them should be corrected during review.
- **Reading the dataset as the physical model.** Datasets such as Process Overview are derived products with
  their own attribute list; they are neither the logical entity nor the storage table.
- **Skipping the mapping.** Similar names are not proof of a link; only DEMO-SEM-006 is.

## Related documents

- **DEMO-SEM-002** — logical model BusinessProcess: the logical side of every example in this guide.
- **DEMO-SEM-005** — physical model ProcessMetadataTable: the physical side, with the `owner_role_code` column.
- **DEMO-SEM-006** — mapping between the logical and physical models; the authoritative link used in step 4.
- **DEMO-SEM-007** — Process ID contract that constrains both levels (step 5).
- **DEMO-PROC-004** — logical model review process, where the checks from this guide are applied.
