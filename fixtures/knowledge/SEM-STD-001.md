---
id: SEM-STD-001
title: Стандарт оформления документов базы знаний (демо)
type: standard
status: approved
owner: demo-team
tags: [standard, metadata, demo]
related_ids: [SEM-GLOSS-001]
reviewed_at: 2025-01-15
updated_at: 2025-01-15
---

# Стандарт оформления документов базы знаний (демо)

**ДЕМО-ДАННЫЕ.** Пример стандарта для приложения; дата проверки намеренно устарела, чтобы показать предупреждение.

## Обязательные поля
Каждый документ содержит поля id, title, type, status, owner и tags. Идентификатор id не меняется после создания.

## Жизненный цикл
Статусы меняются по цепочке draft → in_review → approved → deprecated. Перевод в approved выполняется только через ревью и merge в GitLab.
