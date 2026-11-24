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

## Templates help structure, they do not gate creation

A document can be created **without a template** («Пустой документ», as in Obsidian or Notion): a title and a
catalogue section, then free Markdown with `[[` WikiLinks, preview and the AI actions that make sense without a
template (metadata, related documents, improve, summarize, explain). The server writes the technical metadata
(`docs/METADATA_AND_LINKS.md`); there are no required sections. The completeness check («Проверить полноту»)
needs a template and appears once one is applied. «По шаблону» stays as it was: the template gives the skeleton,
the section and the default tags at once.

### «Применить шаблон» — later, to an existing draft or document

In the editor (a saved draft without unsaved edits) and in the document page's «Ещё» menu. The person chooses an
ACTIVE template (draft / deprecated / archived / hidden ones are refused), sees the result as a diff, and confirms:

| Target | On confirm | Guard |
|---|---|---|
| a draft (blank, imported or of another template) | the draft is updated: `template` + `template_version` pinned to the **current active** version | `expected_version` (the draft's `edit_version`) |
| an indexed document (approved or not) | a **change proposal** via the usual «Предложить изменение» path; the original is never modified | `base_revision` (the document's revision) |

Both also refuse a confirm whose template version is no longer the active one (`template_version_changed`): a
pinned version is never switched silently. The algorithm (`app/domain/template_apply.py`):

1. Keep **all** content: every existing line stays, in its order; the body only gains lines.
2. Map an existing `## ` heading to a template section when the titles match (case and surrounding spaces ignored —
   the same rule as the template validation). `##` lines inside code fences are text.
3. For each missing **required** section, add the template's skeleton (the «Требует уточнения» placeholder) after
   the nearest preceding template section present in the document (template order where the document allows it),
   else before the nearest following one, else at the end. Missing optional sections are not added.
4. Keep sections the template does not know, unchanged and in place.
5. In the YAML change only `type` (to the template's section — the preview says when it changes), `template` and
   `template_version`; the ID, status, owner, relations and dates stay byte for byte. IDs never change, so a
   `SEM-DOC-NNN` document keeps its ID under any template.

Applying the same template again is `template_apply_no_change`. API: `docs/API_CONTRACTS.md` («Blank documents and
«Применить шаблон»»). Checks: `tests/test_blank_document.py`, `src/__tests__/blankDocument.test.tsx`,
`e2e/blankDocument.spec.ts`.

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
