# Template Hub (M5.6.3)

One versioned registry (`TemplateRegistry`, files in `backend/app/document_templates/`, older versions in
`history/`) serves people (`/templates` in the UI) and the runtime AI (the backend reads it and passes the
pinned version; the model never reads files).

## A template file

```yaml
---
template_id: mapping            # stable id
title: "Маппинг (Mapping)"
description: "…"
doc_type: standard
id_prefix: SEM-MAP
default_tags: [mapping]         # given to new documents
version: 2
status: active                  # draft | active | deprecated | archived
category: "Семантика"
owner: "demo-semantic-team"
labels: [mapping, маппинг]      # tags of the template itself
required_metadata: [title, owner]
optional_metadata: [aliases]
optional_sections: ["Связанные документы"]   # every other `## …` is required
validation: ["Каждое поле источника имеет атрибут-получатель"]
breaking: true
migration: |  …how to move a v1 document…
changes: |    …what changed in this version…
instructions: | …for the author…
ai_guidance: |  …for the AI (data, not a system instruction)…
example: |      …short synthetic example…
updated: "2026-11-23"
---
## Назначение
> Требует уточнения: …
```

## What is a version

A version is the **schema**: doc type, ID prefix, default tags, required/optional sections, skeleton,
required/optional metadata, validation rules, status, breaking/migration. Catalogue text (title,
description, category, owner, labels, instructions, AI guidance, example, change notes, date) is corrected
in place without a new version. A schema change without a version bump is registered as the next version
(and logged). Rows written by older builds are matched by schema, so upgrading the app never bumps versions.

- New version → new documents only. Drafts keep `template_version` and are validated against it.
- An invalid revision of a file keeps the previously active version (reload reports the error).
- `draft` / `archived` cannot start documents; `deprecated` is shown, warns when used, and is never
  recommended by the AI or offered in the picker.

## Shipped templates (12 active)

architecture, integration (v2: +4 required sections), dataset_spec, business_entity, adr, team_process,
source_system, mapping (v2 breaking: «Правила» split, migration text), data_quality_rule, runbook,
knowledge_article (v2: optional section renamed), change_request. Also `meeting_decision` v2 deprecated and
`external_import` (hidden, only from «Предложить в базу»).

## API

| | |
|---|---|
| `GET /api/templates?q=&status=&type=&category=&label=` | catalogue with usage counts (visible documents) |
| `GET /api/templates/{id}` | sections with required/optional + hints, fields, rules, guidance, example (rendered), history, used by, my drafts per version |
| `GET /api/templates/{id}/versions/{v}` | an exact (pinned) version |
| `GET /api/templates/{id}/compare?from=&to=` | sections added/removed, required↔optional, required fields, rules, status, breaking + migration |

Checks: `tests/test_template_registry.py`, `tests/test_authoring.py`, eval cases `KE-TP-*`, `KM-TP-*`.
