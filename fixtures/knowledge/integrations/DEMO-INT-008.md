---
id: DEMO-INT-008
title: "Catalog → Dataset: разрешение ссылок (демо)"
type: integration
status: approved
owner: demo-integration-team
version: "1.0"
synthetic: true
reviewed_at: 2026-11-05
updated_at: 2026-11-05
tags: [catalog, каталог, dataset, датасет, reference-resolution, разрешение-ссылок, references, ссылки, catalog-asset, integration, интеграция]
aliases: ["catalog reference resolution", "разрешение каталожных ссылок", "catalog to dataset resolution"]
summary: "Как активы Data Catalog (catalog_asset_id) разрешаются в строки датасетов по точному ключу source_key после события catalog_load_completed; неразрешённые ссылки попадают в отчёт rpt_unresolved_refs и никогда не угадываются."
related_ids: [DEMO-SEM-011]
relations:
  consumes: [DEMO-SRC-007]
  depends_on: [DEMO-SEM-004]
---

# Catalog → Dataset: разрешение ссылок (демо)

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Датасеты учебного семантического слоя строятся из сущностей, описанных активами Data Catalog (`SYS-CAT`). Этот
поток поддерживает связь «актив каталога ↔ строка датасета»: после каждой загрузки в каталог он находит для
актива ровно одну строку нужного датасета и записывает связь. Главное правило — ссылка разрешается только по
точному ключу; неразрешённая ссылка попадает в отчёт и **никогда не угадывается**.

## Источник и получатель

- Источник — Data Catalog (профиль DEMO-SRC-007): активы классов `BusinessProcess`, `BusinessObject`,
  `SourceSystem` и служебное событие `catalog_load_completed`, которое каталог публикует в Event Hub после
  каждой успешной загрузки процессов или изделий.
- Получатели — датасеты, описанные по логической модели Dataset (DEMO-SEM-004): Process Overview (`DS-001`),
  Dependency Graph (`DS-002`), Source Coverage (`DS-003`). Поток ведёт таблицу связей `catalog_dataset_links` и
  отчёт `rpt_unresolved_refs`.

## Входные данные (Inputs)

Активы, изменённые загрузкой, о которой сообщило событие `catalog_load_completed`:

- `catalog_asset_id` — непрозрачный идентификатор актива вида `CAT-` + 8 цифр (например, `CAT-00004417`);
- `asset_class` — `BusinessProcess`, `BusinessObject` или `SourceSystem`;
- `source_key` — ключ в источнике: `process_id`, идентификатор узла (`SYS-CATIA:CP-104233`) или код системы;
- `asset_state` — `active`, `deprecated` или `archived`;
- `source_system` — код системы-источника.

## Выходные данные (Outputs)

- Строка таблицы `catalog_dataset_links`: `catalog_asset_id` → (`dataset_id`, ключ строки датасета).
- Запись в `rpt_unresolved_refs` для каждой неразрешённой ссылки: `catalog_asset_id`, причина, время попытки.
- `catalog_asset_id` — это не `lineage_ref`. Поле `lineage_ref` Process Overview имеет формат
  `LIN-ARIS-PRC-000417` (шаблон `^LIN-[A-Z]+-PRC-\d{6}$`), вычисляется при сборке датасета, и поток его не меняет.

## Правила преобразования (Transformation Rules)

Ключ строки берётся из описания датасета по логической модели Dataset (DEMO-SEM-004): `source_key` сравнивается
только с атрибутом, который в датасете является ключом.

| `asset_class` | Датасет | Ключ строки |
|---|---|---|
| `BusinessProcess` (`SYS-ARIS`) | Process Overview (`DS-001`) | `process_id` |
| `BusinessObject` (`SYS-CATIA`) | Dependency Graph (`DS-002`) | `node_id` |
| `SourceSystem` | Source Coverage (`DS-003`) | `system_code` |

1. Сравнение только точное: без поиска по названию, без нечёткого совпадения, без выбора «ближайшей по времени»
   строки.
2. Ноль совпадений — причина `not_found`; больше одного — `ambiguous`; актив в состоянии `deprecated` или
   `archived` — `inactive_asset`; класс вне таблицы — `unsupported_class`.
3. При любой из этих причин связь не создаётся, а запись уходит в `rpt_unresolved_refs` с кодом `E-MAP-001`.
4. Повторное разрешение уже связанной пары ничего не меняет: поток идемпотентен.
5. Если Event Hub был недоступен, ежедневная сверка в 03:45 (условное время) перебирает все активы, изменённые
   за сутки, и догоняет пропущенные события.

## Ограничения (Constraints)

- Поток только читает каталог: не создаёт активов и не меняет их состояние.
- В датасетах поток не меняет значения атрибутов — он ведёт только таблицу связей и отчёт.
- Неразрешённые ссылки — сигнал для датасета Source Coverage (DEMO-SEM-011), который опирается на список систем
  из каталога: отчёт `rpt_unresolved_refs` показывает, какие активы ещё не имеют строки в датасетах.
- Ручная привязка «по смыслу» не допускается: исправлять нужно данные источника или таблицы маппинга, после чего
  ссылка разрешится при следующей загрузке или сверке.

## Ошибки и обработка (Error Cases)

| Код | Ситуация | Обработка |
|---|---|---|
| `E-MAP-001` | `not_found`, `ambiguous`, `inactive_asset`, `unsupported_class` | повторы по общей политике (датасет может пересобраться между попытками); если ссылка так и не разрешилась — `dlq.metadata.v1` и запись в `rpt_unresolved_refs` |
| `E-SRC-003` | каталог недоступен | до 5 повторных попыток, затем `dlq.metadata.v1`; прежняя таблица связей остаётся в силе |

Запись отчёта закрывается автоматически, когда ссылка разрешается.

## Версия и статус

Версия 1.0, статус approved, дата проверки 2026-11-05. Первая утверждённая версия; до неё разрешение ссылок
описывалось только внутри документов отдельных потоков.

## Пример

Инкремент ARIS в 12:00 обновил актив процесса, каталог опубликовал `catalog_load_completed`:

```yaml
- catalog_asset_id: CAT-00004417
  asset_class: BusinessProcess
  source_key: PRC-000417
  result: resolved        # строка DS-001 с process_id = PRC-000417; её lineage_ref = LIN-ARIS-PRC-000417 не меняется
- catalog_asset_id: CAT-00104233
  asset_class: BusinessObject
  source_key: "SYS-CATIA:CP-104233"
  result: resolved        # строка DS-002 с node_id = SYS-CATIA:CP-104233
- catalog_asset_id: CAT-00004999
  asset_class: BusinessProcess
  source_key: PRC-000999
  result: not_found       # строки нет в DS-001 → E-MAP-001, запись в rpt_unresolved_refs
```

Для `PRC-000999` поток не ищет процесс с похожим названием: связи нет, пока данные не исправлены.

## Связанные документы

- **DEMO-SRC-007** (`consumes`) — Data Catalog: идентификаторы и классы активов, `source_key`, событие
  `catalog_load_completed`.
- **DEMO-SEM-004** (`depends_on`) — логическая модель Dataset: идентификаторы `DS-*` и ключевые атрибуты строк,
  по которым выполняется разрешение.
- **DEMO-SEM-011** (ссылка) — датасет Source Coverage: покрытие источников, для которого важен отчёт о
  неразрешённых ссылках.
