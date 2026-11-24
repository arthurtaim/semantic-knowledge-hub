# Metadata without YAML, WikiLinks and backlinks (M5.6.3)

## Who owns which field

| Class | Fields | Authority |
|---|---|---|
| Server | `id` (allocated once at creation, immutable), initial `status: draft`, timestamps, origin (`manual`, `import`, `ai_suggestion`, `external_page`), revision guard (`edit_version` / `base_revision`), pinned `template` + `template_version` | backend only; the AI cannot set them |
| Person | title, owner, tags, summary, business meaning | typed or explicitly accepted; an unknown owner is `unassigned`, never invented |
| Parser | headings, WikiLinks with their line, existing valid YAML | deterministic; a WikiLink is `references`, never `depends_on` |
| Suggestion | tags, summary, related documents, template | `suggested` with evidence; applied only on Accept |
| External | Confluence page / version / ACL | MCP adapter; never upgraded to approved |

## Creating a document

`POST /api/authoring/drafts` with `metadata.id` empty → the backend allocates the next free `<PREFIX>-NNN`
of the template under a lock (no two drafts share an ID); saving the draft with another ID is
`422 document_id_immutable`. `client_request_id` makes a retried request return the same draft. Duplicate
titles are allowed (IDs differ) and produce a `duplicate_title` warning. `GET /api/document-types` lists
types, their active templates and which fields the server owns.

### A blank document (no template)

`POST /api/authoring/drafts` without `template_id` («Пустой документ»). The server composes the technical metadata
itself; the person gives only what a person knows:

| Field | Value | Who |
|---|---|---|
| `id` | next free `SEM-DOC-NNN` (`GET /api/authoring/blank` previews it), allocated once under the same lock, immutable — also after a template is applied later | server |
| `status` | `draft`; approved only through review + merge | server |
| `owner` | the form's value (the editor pre-fills the current user), empty → `unassigned` | person / server |
| `type` | the section the person chose from the existing types (`GET /api/document-types`); `guide` («Руководства») when none is chosen — never invented; can be changed while it is a draft | person |
| origin | `manual` (`import` for an import); dates and the revision guard (`edit_version`) as for every draft | server |
| `template`, `template_version` | absent until «Применить шаблон» pins them (`docs/TEMPLATE_HUB.md`) | server, on the person's confirm |
| title, tags, summary, related_ids, source_refs | as typed | person |

The body is free Markdown: no required sections, WikiLinks are `references` edges as always; the size, secret,
personal-data and unsafe-markup checks are the same. A draft without a template — a blank one or an imported file
— opens in the same editor; YAML keys the form does not show (e.g. `relations`, `aliases`, `reviewed_at`) are kept
on every save.

## Importing Markdown

| Input | Preview state | What happens on create |
|---|---|---|
| valid YAML, new ID | `ready` (fields `existing`) | draft with the file kept verbatim (`keep_original_metadata`); `status: approved` in the file only takes effect after review + merge |
| valid YAML, ID already in the base | `conflict` | not imported: propose a change on the document page |
| invalid YAML | `invalid_metadata` + generated replacement fields | draft with generated YAML (accepted fields) |
| no YAML | `needs_metadata_review` | draft with generated YAML: title from `# H1`, template suggested with reasons, owner missing → `unassigned`, tags / summary / related suggested; without any active template (or `template_id` left out on create) a blank `SEM-DOC-NNN` document |

`POST /api/documents/import/preview` writes nothing. Files in the knowledge root without valid YAML are
listed by `GET /api/documents/import/staging`; they are never indexed or cited, and the original file is
never rewritten (the local adapter reads them only inside the root, without symlinks).

## WikiLinks

```markdown
См. [[DEMO-SEM-002]], [[DEMO-SEM-002|логическую модель]] или раздел [[DEMO-SEM-002#атрибуты|атрибуты]].
В таблице подпись отделяется экранированной чертой: [[DEMO-SRC-002\|источник]].
```

- Parsed as an inline rule of the document parser (markdown-it): fenced/indented code, inline code and
  `\[[…]]` are never links; YAML is split off first. Labels are HTML-escaped.
- The stored target is the stable ID. `[[Название]]` is NOT resolved automatically: it is reported as a
  title link (or an ambiguous title) with candidates; the editor's `[[` autocomplete inserts `[[ID|Title]]`.
- Each linked ID becomes one `references` edge (`field: body`, line) in the same index generation as the
  catalogue, FTS and graph. A target also listed in `related_ids` is ONE edge with provenance
  `["related_ids", "body:12"]`. Typed relations (`maps_to`, …) stay separate edges.
- Rename/move keeps links (stable ID); removing a link removes its edge on the next sync; deleting a target
  leaves an `unresolved: missing` entry and a dangling graph diagnostic — never a redirect to a lookalike.

| API | |
|---|---|
| `GET /api/documents/{id}/links` | outgoing (via inline / related_ids / typed), backlinks with excerpts, unresolved with candidates |
| `GET /api/links/suggest?q=` | autocomplete over IDs, titles (ё = е), aliases; deprecated last |
| `GET /api/links/diagnostics` | unresolved links across the base |

Everything is computed from the reader's snapshot: a document the reader cannot see contributes no title,
backlink, count, preview or candidate.

Checks: `tests/test_metadata_pipeline.py`, `tests/test_wikilinks.py`, eval cases `KM-MD-*`, `KM-WL-*`.
