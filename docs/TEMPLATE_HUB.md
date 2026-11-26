# Template Hub (M5.6.3)

One versioned registry (`TemplateRegistry`, files in `backend/app/document_templates/`, older versions in
`history/`, and templates made in the app — «Template Studio» below) serves people (`/templates` in the UI) and the
runtime AI (the backend reads it and passes the pinned version; the model never reads files).

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

| `GET /api/templates/{id}/studio` and the other Template Studio routes | `docs/API_CONTRACTS.md` «v0.6, Template Studio» |

Checks: `tests/test_template_registry.py`, `tests/test_authoring.py`, `tests/test_template_studio.py`, eval cases
`KE-TP-*`, `KM-TP-*`.

## Template Studio — creating and editing templates in the app

A person creates, edits, checks, versions and activates templates in the UI (`/templates` → «Создать шаблон»,
`/templates/:id` → «Редактировать»; editor `/templates/new`, `/templates/:id/edit`) — no code change, no file on the
server. There is still ONE registry: the studio stores into it and reads from it; nothing else holds templates.

### Storage (persistent, never in the image)

Studio state lives in the app-state SQLite database the registry already uses (`APP_STATE_PATH`, in Docker
`/data/workspace/app_state.sqlite3` on the `workspace` volume; the image and `app/document_templates/` stay
read-only):

| Table | Holds |
|---|---|
| `template_versions` (existing) | every version of every template; studio versions have `origin = studio` (files: `active` / `history`) |
| `template_studio` | one row per template the studio manages: `kind` (`created` / `adopted`), the current version, `revision` (optimistic lock), the open draft (a spec as JSON) and its base version, the acknowledged shipped version, who/when |
| `template_studio_events` | the history: `created`, `adopted`, `draft_saved`, `draft_discarded`, `deleted`, `activated`, `info_updated`, `reactivated`, `shipped_acknowledged` — actor, time, version, revision, summary |

A studio version is stored as the same template the file parser produces: the spec is rendered to the shipped file
format and parsed by `parse_template_text`, so a studio version and a file obey the same rules. State survives a
backend restart and a redeploy that keeps the volume (`tests/test_template_studio.py::test_s10_…`).

### Shipped and studio templates side by side

- **A new template** gets an ID that no template has ever had (shipped, removed, studio) and that is not reserved
  (`new`, `studio`, `edit`). A later release that ships a file with that ID does not take it over: the file is
  ignored and the reload reports it.
- **Editing a shipped template adopts it** (`kind: adopted`, on the first saved draft): from then on the studio says
  which version is current, and the file's catalogue text no longer overwrites the stored versions.
- **A release ships a new version of an adopted template**: the registry registers it (readable, comparable) but
  it does NOT become current; the template reports `shipped_update: N` (catalogue, template page, editor). A person
  either activates vN («Активировать vN из поставки», a normal confirmed activation) or keeps the studio version
  («Оставить действующую», which acknowledges vN). Nothing is overwritten silently.
- Templates the studio never touched behave exactly as before.

### Versions, drafts and activation

- A version is still the **schema** (`SCHEMA_FIELDS`, `schema_checksum`); the catalogue text (title, description,
  category, owner, labels, instructions, AI guidance, example, change notes) is corrected in place.
- Every edit goes into the template's **draft** («Сохранить черновик»). A draft is not a version: documents cannot
  start from it or pin it, the AI never sees it, the catalogue and the template page keep showing the current
  version (with «есть черновик»). A new template exists only as a draft (catalogue status «Черновик шаблона») until
  its first activation. A draft may be saved with errors; they are shown next to the fields.
- **«Активировать»** is a separate right and a confirmed step (a sheet with what happens and the comparison):
  new schema → the next free version number becomes current; same schema → the catalogue text of the current version
  is updated in place (`info_updated`, no new version); the schema of an older version → that version is current
  again (`reactivated`). An existing version can also be made current from the history (rollback).
- Documents and drafts keep their pinned `template_version` and are validated against it — nothing is migrated
  (`test_s7_…`). Old versions stay readable (`/templates/:id?version=N`) and comparable with each other and with the
  draft (`…/studio/compare?from=N&to=draft`: sections, fields, rules, status, changed fields, line diff of the
  template source).
- History: every write is an event with author and time; the editor shows versions (who activated, how many visible
  documents are pinned to each) and the event log.

### Concurrency

Every write names `expected_revision` (`0` for a shipped template the studio never touched). The registry updates
`WHERE revision = ?` in one transaction: of two editors on the same revision the second gets `409 template_conflict`
with the current revision and who saved it; the editor keeps the person's edits and offers «Загрузить сохранённое»
or «Оставить мои правки и сохранить поверх» (an explicit overwrite on the new revision).

### Validation (server-side, bound to fields)

`template_id` (pattern, unique, reserved, never changes), title, document type (existing types), `id_prefix`
(pattern; not `SEM-DOC` — blank documents; not used by another ACTIVE template or a new-template draft, because IDs
are allocated per prefix — a new studio rule, shipped files are not checked; ownership: an active template — shipped,
adopted or studio — owns its prefix, so its own draft never conflicts with it and a foreign draft can never block its
activation; a draft of a never-activated template reserves only a prefix no active template owns, the earliest such
draft wins; a foreign draft naming an owned prefix gets `id_prefix_taken` when it is created or checked and cannot be
activated — post-M6 remediation SYS-002), labels and tags, sections (at least
one, at least one required, non-empty unique titles case-insensitively, one line, no `#`/`##` lines inside content),
metadata only from `METADATA_FIELDS`, `title` required, no field both required and optional, rules non-empty and
unique, a breaking version needs migration text, sizes (header ≤ 16 KB, template ≤ 32 KB), and finally the file
parser itself. Missing description / category / owner are warnings.

### Rights

`view_templates` (catalogue, versions, studio state, checks), `create_template` (a new template, also from an AI
proposal), `edit_template` (save / discard drafts, acknowledge a shipped update), `activate_template` (make a draft
or a version current). Local demo: the single operator has all four. Role proposal: `docs/SSO_RBAC_REQUIREMENTS.md`.

### Markdown ↔ section builder

One structure (`spec.sections`), two views. A section is `## Title`, optionally `> Требует уточнения: hint`, then
free content (a table, a list); a section with neither gets the bare placeholder. Text before the first `##`, or a
`#` heading, cannot be mapped: the editor says so, keeps the last mapped structure and blocks saving until the text
is fixed or reset. Markdown cannot say «необязательный»: a section keeps its flag by title, a new one is required.
Every shipped template round-trips exactly (`render(parse(body)) == body`), so saving a template unchanged never
creates a version. Backend `app/domain/template_studio.py`, frontend mirror `src/lib/templateSpec.ts`.

### «Создать с помощью AI»

The AI proposes; people decide (`docs/AI_WORKFLOWS.md` «Template proposals»): the proposal opens in the editor, the
template appears only on «Сохранить черновик», activation is separate. Available with a language model
(`internal_api`, `claude_cli`); with `mock` the button is disabled with a one-line reason; with `disabled` there is
no button.

### Limits

- Templates are not deleted once activated (documents may pin them); a status `deprecated` / `archived` version
  retires one. Only a never-activated template disappears with its draft.
- One open draft per template (concurrent editors are serialized by the revision, not merged).
- `listed` and `order` are kept from the shipped template (new templates: listed, order 100); they are not editable.
- The studio does not import ZIP / bulk files and does not publish templates to GitLab or Confluence.
