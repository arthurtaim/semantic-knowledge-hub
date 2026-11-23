# Synthetic knowledge base (M5.6.2): conventions, catalog and shared facts

Everything here is **fictional**. No identifier, field, schedule, limit, role or procedure describes a real
bank system. ARIS and CATIA appear only as names of vendor tool *types* in a training scenario; nothing
states how a real bank uses them. Documents are data for testing retrieval, sync, graph and AI grounding.

## 1. Layout

```
fixtures/knowledge/            9 original SEM-* documents (the demo application itself) — kept as is
fixtures/knowledge/sources/    DEMO-SRC-*    source system profiles            type: source
fixtures/knowledge/semantics/  DEMO-SEM-*    glossary, entities, models, datasets  type: glossary | domain | dataset
fixtures/knowledge/integrations/ DEMO-INT-*  integrations and flows           type: integration
fixtures/knowledge/governance/ DEMO-GOV-*    governance, quality, lifecycle    type: standard
fixtures/knowledge/processes/  DEMO-PROC-*   processes and template descriptions  type: process | standard
fixtures/knowledge/decisions/  DEMO-ADR-*    architecture decisions            type: decision
fixtures/knowledge/guides/     DEMO-GUIDE-*  how-to guides                     type: guide
fixtures/eval/                 gold evaluation cases (YAML)
backend/tests/fixtures/knowledge_updates/  mutable snapshots for sync experiments (not part of the base)
backend/tests/fixtures/invalid/, security/  broken and hostile files (never in the base)
```

The slot DEMO-ADR-001 ("why FTS5 in the local demo") is filled by the existing **SEM-DEC-001**; no
duplicate is created. Other documents reference SEM-DEC-001 where they mean that decision.

## 2. Frontmatter

```yaml
---
id: DEMO-INT-002
title: "ARIS → Catalog: маппинг полей (демо)"
type: integration            # overview | architecture | source | domain | dataset | integration | process |
                             # decision | standard | guide | glossary
status: approved             # draft | in_review | approved | deprecated ("superseded" = deprecated + supersedes edge)
owner: demo-integration-team
version: "1.2"               # human document version MAJOR.MINOR (content revision is computed separately)
synthetic: true              # mandatory for every DEMO-* document
reviewed_at: 2026-10-15      # approved/in_review: a date; draft: null
tags: [aris, catalog, mapping, маппинг, integration]
aliases: ["ARIS mapping", "сопоставление полей ARIS"]   # optional alternative names (search)
summary: "Одно-два предложения: о чём документ."
related_ids: [DEMO-GOV-006]  # untyped references (edge type `references`)
relations:                   # typed, directed edges FROM this document TO each target
  depends_on: [DEMO-INT-001]
  maps_to: [DEMO-SEM-002]
---
```

Relation vocabulary (edge `A —type→ B`, declared in A):

| type | meaning |
|---|---|
| `depends_on` | A needs B (rules, flows, policies) to be valid |
| `consumes` | A (integration, dataset, API) reads data or metadata from B |
| `produces` | A (integration) writes or creates B (dataset, catalog content) |
| `maps_to` | A maps fields to B (entity / model) |
| `derived_from` | A (dataset / model) is derived from B |
| `describes` | A describes or profiles B |
| `constrains` | A sets validation or quality constraints on B |
| `supersedes` | A replaces B (B is `deprecated`) |
| `uses_template` | A (process) uses the template described in B |
| `references` | implicit type of `related_ids` |

Only ids from the catalog below may be targets. Never invent a relation that the text does not support:
every edge must be explained in the body (usually in the «Связанные документы» section).

## 3. Body profiles (by type)

Every DEMO document starts with `# <title>` and the line
`> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.`
Then sections by profile (Russian headings; English terms in parentheses are welcome):

- **source**: Назначение · Границы (Scope) · Сущности и идентификаторы · Выгружаемые метаданные (Outputs) ·
  Ограничения · Владельцы и роли · Пример · Связанные документы
- **integration**: Назначение · Источник и получатель · Входные данные (Inputs) · Выходные данные (Outputs) ·
  Правила преобразования (Transformation Rules) · Ограничения (Constraints) · Ошибки и обработка (Error Cases) ·
  Версия и статус · Пример · Связанные документы
- **domain** (entities, models, mappings): Назначение · Определение · Атрибуты (table) · Связи с другими
  сущностями · Ограничения · Пример · Связанные документы
- **dataset**: Обзор · Источники · Бизнес-сущности · Атрибуты (table) · Правила качества · Политика обновления
  (Refresh Policy) · Ограничения доступа · Пример · Связанные документы
- **standard** (governance, template descriptions): Назначение · Область применения · Правила (numbered) ·
  Исключения · Контроль и проверка · Пример · Связанные документы
- **process**: Назначение · Участники и роли · Шаги (numbered) · Входы и выходы · Контрольные точки · Пример ·
  Связанные документы
- **decision**: Контекст · Решение · Рассмотренные альтернативы · Последствия · Статус решения · Связанные документы
- **guide**: Когда использовать · Пошагово · Пример · Частые ошибки · Связанные документы
- **glossary**: terms as `### Термин (English term)` with a definition; abbreviations note competing meanings

Length 350–900 words. Concrete, checkable facts (field names, codes, limits, schedules) — the facts must be
consistent with §5. Do not write URLs, e-mails, phone numbers, personal names or long digit runs (13+
digits look like card numbers to the safety checks). Use roles and team ids instead of people.

## 4. Catalog (74 new documents; with the 9 SEM-* the base has 83)

Status: A = approved, R = in_review, D = draft, X = deprecated. `rel:` = typed relations to declare,
`ref:` = related_ids. Authors may add more edges only to ids in this table or SEM-*.

### A. Sources — `sources/`, type `source`, owner `demo-source-owners`

| ID | Title | St | Edges |
|---|---|---|---|
| DEMO-SRC-001 | Обзор условного ландшафта источников | A | rel describes: SRC-002…SRC-011 · ref: SRC-012, GUIDE-001 |
| DEMO-SRC-002 | ARIS: условная модель процессных метаданных | A | rel depends_on: SRC-012 · ref: INT-001, SEM-002 |
| DEMO-SRC-003 | CATIA: условная модель метаданных изделий | A | rel depends_on: SRC-012 · ref: INT-004 |
| DEMO-SRC-004 | CRM: карточки и идентификаторы | A | ref: INT-006, SRC-006 |
| DEMO-SRC-005 | ERP: справочники и транзакции | A | ref: INT-007 |
| DEMO-SRC-006 | MDM: мастер-данные | A | rel consumes: SRC-004 · ref: INT-006 |
| DEMO-SRC-007 | Data Catalog: описание и поиск активов | A | rel depends_on: SRC-008 · ref: INT-001, INT-004, INT-008 |
| DEMO-SRC-008 | Event Hub: уведомления об изменениях | A | ref: INT-010, INT-009 |
| DEMO-SRC-009 | External Registry: внешний справочник | D | ref: SRC-006 |
| DEMO-SRC-010 | Archive Store: исторические снимки | R (owner `unassigned`) | ref: GOV-008 |
| DEMO-SRC-011 | Data Quality Monitor: контроль качества | A | rel depends_on: GOV-003, GOV-004, GOV-005 · ref: INT-011 |
| DEMO-SRC-012 | Source Ownership & Boundaries | A | rel depends_on: GOV-002 · ref: SRC-001 |

### B. Semantics — `semantics/`, owner `demo-semantic-team`

| ID | Title | Type | St | Edges |
|---|---|---|---|---|
| DEMO-SEM-001 | Глоссарий ключевых терминов семантического слоя | glossary | A | ref: SEM-002, SEM-003, SEM-004, INT-010, ADR-002 |
| DEMO-SEM-002 | Логическая модель: BusinessProcess | domain | A | rel derived_from: SRC-002 · ref: SEM-003, SEM-007 |
| DEMO-SEM-003 | Логическая модель: BusinessObject | domain | A | rel derived_from: SRC-003, SRC-005 · ref: SEM-002 |
| DEMO-SEM-004 | Логическая модель: Dataset | domain | A | ref: SEM-009, SEM-010, SEM-011, PROC-007 |
| DEMO-SEM-005 | Физическая модель: ProcessMetadataTable | domain | A | rel derived_from: SEM-002 · ref: SEM-006 |
| DEMO-SEM-006 | Маппинг логической и физической моделей | domain | A | rel maps_to: SEM-005; depends_on: SEM-002 · ref: GUIDE-005 |
| DEMO-SEM-007 | Контракт атрибута Process ID | domain | A | rel constrains: SEM-002, SEM-005 · ref: INT-002 |
| DEMO-SEM-008 | Справочники и нормализация названий | domain | A | rel depends_on: SRC-006 · ref: SEM-012 |
| DEMO-SEM-009 | Датасет Process Overview | dataset | A | rel derived_from: SEM-002; depends_on: SEM-004 · ref: INT-015, GOV-003 |
| DEMO-SEM-010 | Датасет Dependency Graph | dataset | A | rel derived_from: SEM-003; depends_on: SEM-004 · ref: INT-005 |
| DEMO-SEM-011 | Датасет Source Coverage | dataset | A | rel derived_from: SEM-006; depends_on: SEM-004, SRC-007 |
| DEMO-SEM-012 | Правила разрешения неоднозначных сущностей | domain | R | rel depends_on: SEM-008 · ref: SEM-001, GOV-007 |

### C. Integrations — `integrations/`, type `integration`, owner `demo-integration-team`

| ID | Title | St | Edges |
|---|---|---|---|
| DEMO-INT-001 | ARIS → Catalog: обзор потока | A | rel consumes: SRC-002; produces: SRC-007; supersedes: INT-018 · ref: INT-002, INT-003, INT-013 |
| DEMO-INT-002 | ARIS → Catalog: маппинг полей | A | rel depends_on: INT-001; maps_to: SEM-002 · ref: SEM-007, GOV-006 |
| DEMO-INT-003 | ARIS: валидационные ограничения | A | rel depends_on: GOV-003; constrains: SEM-009, INT-002 |
| DEMO-INT-004 | CATIA → Catalog: обзор потока | A | rel consumes: SRC-003; produces: SRC-007 · ref: INT-005 |
| DEMO-INT-005 | CATIA → Catalog: маппинг полей | A | rel depends_on: INT-004; maps_to: SEM-003; produces: SEM-010 |
| DEMO-INT-006 | CRM → MDM: синхронизация справочников | A | rel consumes: SRC-004; produces: SRC-006 · ref: SEM-008 |
| DEMO-INT-007 | ERP → Semantic Layer: атрибуты | A | rel consumes: SRC-005; maps_to: SEM-006 · ref: SEM-003 |
| DEMO-INT-008 | Catalog → Dataset: разрешение ссылок | A | rel consumes: SRC-007; depends_on: SEM-004 · ref: SEM-011 |
| DEMO-INT-009 | Source → Dataset: распространение версий | A | rel depends_on: GOV-009, SRC-008 · ref: INT-016 |
| DEMO-INT-010 | CDC и full refresh: сравнение | A | ref: SRC-008, ADR-004, INT-013 |
| DEMO-INT-011 | Интеграционные ошибки и retry | A | rel depends_on: INT-012 · ref: SRC-011 |
| DEMO-INT-012 | Idempotency и дедупликация | A | ref: ADR-003, INT-011 |
| DEMO-INT-013 | Расписание обновления метаданных | A | rel depends_on: INT-010 · ref: GOV-005, INT-001 |
| DEMO-INT-014 | Схема lineage из источника в датасет | A | rel describes: SRC-002, INT-001, INT-002, SEM-009 · ref: GUIDE-002 |
| DEMO-INT-015 | Consumer API: контракт выдачи | A | rel consumes: SEM-009, SEM-010 · ref: INT-016 |
| DEMO-INT-016 | Совместимость схем и breaking changes | A | rel depends_on: GOV-009 · ref: INT-015, INT-009 |
| DEMO-INT-017 | Расписание обновления метаданных v2 — проект | D | rel depends_on: INT-013 |
| DEMO-INT-018 | Ночная полная выгрузка ARIS (устаревший поток) | X | ref: INT-001 |

### D. Governance — `governance/`, type `standard`, owner `demo-governance-team`

| ID | Title | St | Edges |
|---|---|---|---|
| DEMO-GOV-001 | Статусы документов и authority | A | rel depends_on: GOV-009 · ref: ADR-002, GOV-012 |
| DEMO-GOV-002 | Роли: Owner, Reviewer, Steward | A | ref: SRC-012, GOV-012 |
| DEMO-GOV-003 | Качество метаданных: полнота (completeness) | A | ref: SRC-011, INT-003 |
| DEMO-GOV-004 | Качество метаданных: согласованность (consistency) | A | ref: SEM-008, SRC-011 |
| DEMO-GOV-005 | Качество метаданных: актуальность (freshness) | A | ref: INT-013, SRC-011 |
| DEMO-GOV-006 | Правила ссылочной целостности | A | rel constrains: INT-002, SEM-006 · ref: GOV-004 |
| DEMO-GOV-007 | Работа с конфликтующими требованиями | A | ref: SEM-012, GUIDE-004 |
| DEMO-GOV-008 | Политики удаления и архивирования | A | rel depends_on: GOV-009 · ref: SRC-010 |
| DEMO-GOV-009 | Управление ревизиями документов | A | rel supersedes: GOV-013 · ref: ADR-003, GUIDE-004 |
| DEMO-GOV-010 | Ограничения доступа в демо-среде | A | ref: GOV-002 |
| DEMO-GOV-011 | Provenance, цитаты и audit trail | A | rel depends_on: GOV-001 · ref: ADR-003 |
| DEMO-GOV-012 | Тестовый процесс согласования | R | rel depends_on: GOV-002, GOV-001 · ref: PROC-005 |
| DEMO-GOV-013 | Ревизии по дате в имени файла (устаревший регламент) | X | ref: GOV-009 |

### E. Processes and template descriptions — `processes/`, owner `demo-process-office`

| ID | Title | Type | St | Edges |
|---|---|---|---|---|
| DEMO-PROC-001 | Создание новой интеграции | process | A | rel uses_template: PROC-006; depends_on: GOV-002 · ref: PROC-003 |
| DEMO-PROC-002 | Изменение атрибутов датасета | process | A | rel uses_template: PROC-007; depends_on: INT-016 · ref: PROC-004 |
| DEMO-PROC-003 | Заявка на новый источник | process | A | rel uses_template: PROC-008 · ref: SRC-012 |
| DEMO-PROC-004 | Ревью логической модели | process | A | rel depends_on: GOV-012 · ref: SEM-002, GUIDE-005 |
| DEMO-PROC-005 | Публикация утверждённой документации | process | A | rel depends_on: GOV-001 · ref: GOV-011 |
| DEMO-PROC-006 | Шаблон: Integration Specification | standard | A | ref: PROC-010, PROC-001 |
| DEMO-PROC-007 | Шаблон: Dataset Specification | standard | A | rel describes: SEM-004 · ref: PROC-010 |
| DEMO-PROC-008 | Шаблон: Source System Profile | standard | A | ref: PROC-010, SRC-001 |
| DEMO-PROC-009 | Шаблон: Architecture Decision Record | standard | A | ref: ADR-002, PROC-010 |
| DEMO-PROC-010 | Политика изменения версий шаблонов | standard | A | rel depends_on: GOV-009 · ref: ADR-005 |

Template descriptions (PROC-006…009) *describe* the templates; the machine-readable authoring templates live
in `backend/app/document_templates/` (registry) — the documents must say so and must not pretend to be them.

### F. Decisions and guides — `decisions/` (type `decision`, owner `demo-architecture-board`),
`guides/` (type `guide`, owner `demo-enablement-team`)

| ID | Title | St | Edges |
|---|---|---|---|
| (DEMO-ADR-001) | → existing SEM-DEC-001 «ADR-демо — локальный полнотекстовый поиск на SQLite FTS5» | A | — |
| DEMO-ADR-002 | Почему approval управляет authority | A | ref: GOV-001, SEM-DEC-001 |
| DEMO-ADR-003 | Решение о детерминированных source ID | A | ref: GOV-011, INT-012 |
| DEMO-ADR-004 | Стратегия синхронизации: snapshot или события | A | ref: INT-010, SRC-008, SEM-DEC-001 |
| DEMO-ADR-005 | Решение о версионируемых шаблонах | A | ref: PROC-010 |
| DEMO-GUIDE-001 | Как найти описание источника | A | ref: SRC-001, SRC-012 |
| DEMO-GUIDE-002 | Как восстановить lineage датасета | A | ref: INT-014, SEM-009 |
| DEMO-GUIDE-003 | Как проверить ограничения интеграции | A | ref: INT-003, GOV-003 |
| DEMO-GUIDE-004 | Как интерпретировать конфликт ревизий | A | ref: GOV-009, GOV-007 |
| DEMO-GUIDE-005 | How to distinguish logical and physical models (English) | A | ref: SEM-002, SEM-005, SEM-006 |

(In the tables `SRC-002` means `DEMO-SRC-002`, etc.)

## 5. Shared fictional facts (must stay consistent across documents)

- **System codes**: ARIS `SYS-ARIS`, CATIA `SYS-CATIA`, CRM `SYS-CRM`, ERP `SYS-ERP`, MDM `SYS-MDM`,
  Data Catalog `SYS-CAT`, Event Hub `SYS-EVH`, External Registry `SYS-EXTREG`, Archive Store `SYS-ARC`,
  Data Quality Monitor `SYS-DQM`.
- **ARIS export fields** (SRC-002, INT-001/002): `aris_object_guid`, `aris_object_name`, `aris_model_path`,
  `aris_owner_role`, `aris_last_change`, `aris_status`. Catalog fields: `process_id`, `process_name`,
  `process_path`, `owner_role`, `source_changed_at`, `lifecycle_state`.
  Mapping (INT-002): `aris_object_guid` → `process_id` through the lookup table `MAP_ARIS_PROCESS`;
  `aris_object_name` → `process_name` (normalised, SEM-008); `aris_model_path` → `process_path`;
  `aris_owner_role` → `owner_role`; `aris_last_change` → `source_changed_at`; `aris_status` → `lifecycle_state`
  (`released` → `active`, `in_work` → `draft`, `obsolete` → record rejected).
- **Process ID contract** (SEM-007): format `PRC-` + 6 digits (`^PRC-\d{6}$`), immutable, never reused; example
  `PRC-000417` «Согласование заявки (демо)».
- **ARIS validation** (INT-003): mandatory `aris_object_guid`, `aris_object_name`, `aris_owner_role`; model
  hierarchy depth at most **7** levels (`ARIS_MAX_DEPTH = 7`); records with `aris_status = obsolete` rejected;
  a batch is accepted only if **≥ 95 %** of records pass (GOV-003 default), otherwise the whole batch goes to
  quarantine `q_aris_rejected`.
- **Completeness** (GOV-003): default threshold 95 % of mandatory attributes per batch/dataset.
  Scope-specific stricter rule: dataset Process Overview (SEM-009) requires **98 %** for `process_id`,
  `process_name`, `owner_role`. (Scope difference, not a contradiction — documents say so.)
- **Freshness** (GOV-005): catalog metadata at most **24 h** old; Process Overview (SEM-009) at most **12 h**.
- **Schedules** (INT-013, approved): ARIS → Catalog incremental every **6 h** (00:00, 06:00, 12:00, 18:00,
  условное время); CATIA → Catalog daily at **02:30**; CRM → MDM near real time via Event Hub CDC, delay up
  to **15 min**; ERP → Semantic Layer nightly full refresh at **01:00**.
  INT-017 (draft) proposes ARIS → Catalog **hourly** — a proposal, not approved; contradicts INT-013 on purpose.
  INT-018 (deprecated) — old nightly full ARIS export at 03:00, replaced by INT-001 incremental flow.
- **CDC** (INT-010, SRC-008): Change Data Capture events in Event Hub topic `demo.metadata.changes.v1`;
  full refresh batches of **2 000** rows (ERP); ARIS incremental batches of **500** records.
- **Retry** (INT-011): at most **5** attempts, exponential backoff 30 s → 60 s → 2 min → 4 min → 8 min, then
  the message goes to dead-letter queue `dlq.metadata.v1`; error codes `E-MAP-001` (mapping not found),
  `E-VAL-002` (validation failed), `E-SRC-003` (source unavailable).
- **Idempotency** (INT-012): idempotency key = `source_system + source_object_id + source_changed_at`;
  duplicates within 72 h are dropped.
- **Consumer API** (INT-015): synthetic contract `GET /demo/v1/process-overview?process_id=PRC-000417`
  (not a real endpoint); page size 100; limit 60 requests/min per consumer; fields of SEM-009.
- **Datasets**: Process Overview (SEM-009) — `process_id`, `process_name`, `owner_role`, `source_system`,
  `source_changed_at`, `completeness_score`, `lineage_ref`; Dependency Graph (SEM-010) — `node_id`,
  `depends_on_node_id`, `dependency_type`, `source_system`; Source Coverage (SEM-011) — `system_code`,
  `covered_entities`, `coverage_pct`, `last_measured_at`.
- **CATIA** (SRC-003, INT-004/005): `catia_part_number`, `assembly_ref`, `revision_letter`, `material_class`
  → `node_id`, `depends_on_node_id` (from `assembly_ref`), `dependency_type = assembly`.
- **Document versions** (GOV-009): `version` is MAJOR.MINOR; compatible change → MINOR, breaking change →
  MAJOR; the content revision is a hash (local) or commit (GitLab); a superseded document becomes
  `deprecated` with a `supersedes` edge from its successor.
- **Roles** (GOV-002): Owner (владелец), Reviewer (ревьюер), Steward (стюард данных); demo roles
  `demo-reader`, `demo-editor`, `demo-approver` (GOV-010).
- **Templates**: Integration Specification v1 sections — Назначение, Источник и получатель, Передаваемые
  данные, Маппинг, Бизнес-правила, Ограничения, Ошибки, Требования; v2 adds Data Quality Rules, Data
  Lineage, Update Frequency, Validation Constraints. Dataset Specification v1 — Overview, Source Systems,
  Business Entities, Attributes, Mapping Rules, Data Quality, Refresh Policy, Access Restrictions, Related Docs.
  Old drafts keep the template version they were created with (PROC-010, ADR-005).
- **Abbreviations with competing meanings** (SEM-001 lists both): **ADR** — Architecture Decision Record, but in
  the DQ Monitor (SRC-011) ADR is the metric «Average Daily Rows»; **MDM** — Master Data Management, while
  some ARIS texts say «MDM-модель» meaning a metadata model; **CDC** — Change Data Capture; **FTS** —
  full-text search (SQLite FTS5); **DQ** — data quality; **SLA** — not defined for any demo flow (a question
  about an SLA must end in «нет данных»).
- **Synonyms used in texts**: data lineage / линейдж / происхождение данных; mapping / маппинг /
  сопоставление полей; logical model / логическая модель; physical model / физическая модель; data quality /
  качество данных; refresh / обновление; steward / стюард; owner / владелец.

## 6. Gold evaluation cases

YAML list per file in `fixtures/eval/`. Fields:

```yaml
- case_id: KE-SRC-001            # unique; prefix by domain
  category: exact_id             # exact_id | synonym | abbreviation | metadata_filter | relation | synthesis |
                                 # status | no_answer | sync | template | external_rag | external_cache |
                                 # discovery | graph | resource
  question: "DEMO-SRC-002"
  method: search                 # search (top-k of the catalog search) | catalog (filters, exact set) |
                                 # graph_neighbors | graph_path | assistant (grounded answer, mock AI)
  filters: {}                    # catalog/search filters: type, status, owner, tag
  expected_doc_ids: [DEMO-SRC-002]
  k: 1                           # expected ids must be within the top k (search)
  facts_required: ["aris_object_guid"]  # strings present verbatim in an expected document
  facts_forbidden: []
  expected_no_answer: false
  holdout: false                 # ≥ 20 % of cases are holdout: not used to tune synonyms/weights
  start: DEMO-INT-002            # graph methods only
  relation: maps_to              # graph_neighbors only
  direction: out                 # out | in | both
  expected_path: []              # graph_path only
  max_depth: 2
  notes: ""
```

Questions must be answerable from the text actually written (or be deliberate no-answer cases), in Russian
or English as a user would ask, without copying the document title verbatim (except `exact_id` cases).
