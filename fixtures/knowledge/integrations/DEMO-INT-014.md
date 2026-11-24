---
id: DEMO-INT-014
title: "Схема lineage из источника в датасет"
type: integration
status: approved
owner: demo-integration-team
version: "1.2"
synthetic: true
reviewed_at: 2026-07-21
updated_at: 2026-07-21
tags: [lineage, линейдж, происхождение-данных, data-lineage, aris, process-overview, integration, интеграция]
aliases: ["линейдж", "происхождение данных", "data lineage", "цепочка происхождения", "lineage Process Overview"]
summary: "Сквозная схема происхождения данных (data lineage) датасета Process Overview: ARIS → DEMO-INT-001 → DEMO-INT-002 → BusinessProcess → Process Overview; формат lineage_ref вида LIN-ARIS-PRC-000417."
related_ids: [DEMO-GUIDE-002, DEMO-INT-015]
relations:
  describes: [DEMO-SRC-002, DEMO-INT-001, DEMO-INT-002, DEMO-SEM-002, DEMO-SEM-009]
---

# Схема lineage из источника в датасет

> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.

## Назначение

Документ описывает линейдж (data lineage, происхождение данных) датасета Process Overview: через какие
системы, потоки и модели проходит каждое поле от источника ARIS до строки датасета. Схема нужна, чтобы
по любой строке датасета найти исходный объект ARIS и правило, которое его преобразовало, а также чтобы
оценить, какие поля затронет изменение в источнике или маппинге.

## Схема (Lineage Diagram)

```
ARIS (SYS-ARIS, DEMO-SRC-002)               процессные метаданные, поля aris_*
  │  изменения по расписанию, пакеты по 500 записей
  ▼
DEMO-INT-001  поток ARIS → Catalog          доставка в каталог (SYS-CAT)
  │
  ▼
DEMO-INT-002  маппинг полей                 aris_* → поля каталога, таблица MAP_ARIS_PROCESS
  │
  ▼
BusinessProcess (DEMO-SEM-002)              логическая модель процесса
  │
  ▼
Process Overview (DEMO-SEM-009)             датасет для потребителей, поле lineage_ref
```

## Происхождение полей (field-level lineage)

| Поле Process Overview | Поле BusinessProcess / каталога | Поле ARIS | Правило |
|---|---|---|---|
| `process_id` | `process_id` | `aris_object_guid` | через таблицу `MAP_ARIS_PROCESS` |
| `process_name` | `process_name` | `aris_object_name` | нормализация названия |
| `owner_role` | `owner_role` | `aris_owner_role` | перенос значения |
| `source_changed_at` | `source_changed_at` | `aris_last_change` | перевод в UTC |
| `source_system` | — | — | константа `SYS-ARIS` |
| `completeness_score` | — | — | вычисляется при сборке датасета по правилам полноты |
| `lineage_ref` | — | — | формируется по правилу ниже |

Поля каталога `process_path` и `lifecycle_state` участвуют в цепочке до BusinessProcess, но в Process
Overview не передаются.

## Формат lineage_ref

`lineage_ref` = `LIN-` + код источника без префикса `SYS-` + `-` + `process_id`. Для процесса
`PRC-000417` из ARIS значение — `LIN-ARIS-PRC-000417`. Шаблон проверки: `^LIN-[A-Z]+-PRC-\d{6}$`.

Так как `process_id` неизменяем и не переиспользуется, `lineage_ref` строки тоже не меняется, пока процесс
существует. Ссылка указывает на цепочку происхождения, а не на конкретный запуск загрузки: момент
последнего изменения показывает `source_changed_at`.

## Ограничения

- Схема описывает путь на уровне документов и полей; построчный журнал запусков загрузки в неё не входит.
- В учебной модели единственный источник Process Overview — ARIS; другие источники в этой цепочке не участвуют.
- Записи с `aris_status = obsolete` отклоняются на валидации и не получают `lineage_ref`.

## Ошибки и обработка (Error Cases)

- Если для `aris_object_guid` нет строки в `MAP_ARIS_PROCESS`, цепочка обрывается на шаге DEMO-INT-002:
  записи нет в каталоге и датасете, а сообщение уходит в обработку ошибок с кодом `E-MAP-001`.
- Если `lineage_ref` строки не соответствует шаблону, строка считается дефектной и разбирается владельцем
  датасета; потребителям такой ссылке доверять нельзя.

## Версия и статус

Версия 1.2, статус approved. Версия 1.2 (MINOR) добавила таблицу происхождения полей.

## Пример

Потребитель получил строку Process Overview с `process_id = PRC-000417`, названием «Согласование заявки
(демо)» и `lineage_ref = LIN-ARIS-PRC-000417`. Восстановление происхождения:

1. Код `ARIS` в `lineage_ref` указывает на источник `SYS-ARIS` (DEMO-SRC-002).
2. В BusinessProcess (DEMO-SEM-002) находится процесс `PRC-000417`.
3. По таблице `MAP_ARIS_PROCESS` (DEMO-INT-002) определяется соответствующий `aris_object_guid`.
4. Время `source_changed_at` (`2026-10-14T06:12:00Z`) — это `aris_last_change` объекта, приведённый к UTC;
   по нему видно, каким запуском потока DEMO-INT-001 доставлено последнее изменение (здесь — запуском 12:00).

Пошаговая инструкция для пользователя — в DEMO-GUIDE-002.

## Связанные документы

- DEMO-SRC-002 — профиль ARIS, начальное звено схемы (`describes`: документ описывает его роль в цепочке).
- DEMO-INT-001 — поток ARIS → Catalog, второе звено (`describes`).
- DEMO-INT-002 — маппинг полей и таблица `MAP_ARIS_PROCESS`, третье звено (`describes`).
- DEMO-SEM-002 — логическая модель BusinessProcess, четвёртое звено (`describes`).
- DEMO-SEM-009 — датасет Process Overview, конечное звено и владелец поля `lineage_ref` (`describes`).
- DEMO-GUIDE-002 — практическое руководство по восстановлению lineage датасета (ссылка).
- DEMO-INT-015 — Consumer API, через который `lineage_ref` получают потребители (ссылка).
