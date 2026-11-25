# API contracts and interface shapes

These are proposed MVP HTTP contracts. Claude Code may refine field details but must document changes, keep tests consistent and preserve adapter boundaries. All routes prefixed `/api`.

**Current implemented contract: v0.5 (v0.4 + M5.7 system facts and tool steps)** — see the last sections. Earlier sections describe the original proposal and the v0.1/v0.2 refinements, which remain valid unless v0.3 says otherwise. The served schema is `GET /api/openapi.json`.

## 1. Health and integrations
- `GET /api/health` -> `{ "status": "ok", "mode": "local_demo" }` (no secrets).
- `GET /api/integrations/status` -> provider status list with `name`, `state` (`connected|disabled|mock|error`), `capabilities`, `human_readable_message`. Never report `connected` solely because an environment variable is set; probe if enabled.

## 2. Knowledge
- `GET /api/documents?query=&type=&status=&owner=&source=&page=1&size=20` -> `{items:[DocumentSummary],total,page,size}`.
  - *UI v2 round 2 (additive).* Each item carries `link_count: int` — the distinct documents linked to it in the
    **reader's** snapshot: targets of its declared, `related_ids` and inline `[[ID]]` relations plus the documents whose
    relations point at it. Same number as the document page's «Связи» (`GET /api/documents/{id}/links`: outgoing
    targets ∪ backlink sources); a document the reader cannot see neither appears nor counts. Computed in one pass over
    the snapshot the list is built from (cached per snapshot), never per row. Other routes that return a
    `DocumentSummary` / `DocumentDetail` leave it `null`. Code: `services/knowledge.py` `linked_document_counts`;
    tests `tests/test_catalog_fields.py`.
  - *UI v2 round 2 (additive).* `metadata_updated_at: date | null` on every `DocumentSummary` / `DocumentDetail`: the
    document's own date, `updated_at: YYYY-MM-DD` in its front matter (`docs/DOCUMENT_SCHEMA.md`); `null` when the
    document has none — it is never filled from the file, the commit or the index. The catalog's «Обновлён» shows it
    («—» without it), and `sort=updated` orders by it (newest first, undated last by title). `updated_at` keeps its
    meaning: the time of the source revision (commit date / file mtime), shown on the document page as «Дата
    ревизии». A front-matter value that is not a date is a warning `invalid_updated_at` (kept in `extra_metadata`),
    never a load error.
  - *«Документы» v2 (additive).* Each item also carries `summary: str | null` (the document's `summary`: the
    front-matter value, else its first meaningful paragraph — the same value as `DocumentDetail.summary`) and
    `systems: list[str]` (the systems the document is about, rule below). Other routes that return a
    `DocumentSummary` leave both `null`; `DocumentDetail` keeps its `summary` and also fills `systems`.
  - *«Документы» v2 — whole-base search (no contract change).* With `query`, the list is the same search as
    `GET /api/search` (team scope), one row per document instead of passages: the same SQLite FTS5 index and the same
    ranking (`RetrievalService.rank_documents`: exact ID, title, full text, declared-relation expansion) over the same
    **reader's snapshot**, which is the access check of both routes — a document the reader cannot see is found by
    neither, not even through the shared index or a relation. The list keeps up to 1000 matches, so for a query of
    several words it may add partial (OR) matches that the top-N of `/api/search` leaves out. Every item carries its
    provenance: `source` (`local|gitlab|confluence`), `source_uri`, `revision` (required fields, as before). Tests:
    `tests/test_doc_tree.py::test_a_hidden_document_is_found_by_neither_documents_query_nor_search`,
    `::test_documents_query_ranks_like_search_and_every_result_carries_its_source`.
- `GET /api/documents/tree` (*«Документы» v2, new*, `read_knowledge`) -> the whole visible base as sections → groups →
  documents in one response, no paging. Spec: `docs/ui-v2/documents/specs/DOCUMENTS_V2.md` §4; code:
  `app/domain/doc_tree.py` (rule and order), `services/knowledge.py` `document_tree`; tests `tests/test_doc_tree.py`.

  ```json
  {
    "total": 83,
    "attention_total": 12,
    "sections": [
      { "key": "integration", "label": "Интеграции", "count": 19, "attention": 3, "doc_ids": [],
        "groups": [ { "key": "integration/aris", "label": "ARIS", "count": 8, "attention": 3,
                      "doc_ids": ["SEM-INT-ARIS-001", "DEMO-INT-018", "…"] } ] }
    ],
    "documents": {
      "DEMO-INT-001": { "title": "ARIS → Catalog: обзор потока (демо)", "type": "integration", "status": "approved",
        "review_state": "ok", "reviewed_at": "2026-10-16", "owner": "demo-integration-team", "owner_missing": false,
        "summary": "…", "systems": ["ARIS", "Data Catalog"], "link_count": 11, "is_demo": true, "source": "local",
        "index_state": "current", "group": "integration/aris", "attention": false }
    }
  }
  ```

  - **Visibility.** Built from the reader's snapshot, exactly like `GET /api/documents` (same service, no bypass):
    a document the reader cannot see is neither an entry nor counted, and a source system document the reader
    cannot see names no group and no system. `link_count` is the catalog's (§2 above).
  - **`review_state` / `reviewed_at`.** The catalog's values, unchanged: `reviewed_at` is the front-matter date;
    `review_state` is `ok`, `stale` (the review is older than `REVIEW_STALE_DAYS`, 180 by default — the catalog's
    «Проверка устарела»), `never_reviewed` (approved or in review without `reviewed_at`) or `not_required` (a draft or
    a deprecated document without `reviewed_at`). It depends on today's date.
  - **`attention`** (per document; `attention` of a section / group and `attention_total` count them): `status` ∈
    {`in_review`, `draft`, `deprecated`} **or** `review_state` ∈ {`stale`, `never_reviewed`} **or** `owner_missing`.
  - **Groups (computed; no `parent` field yet).** A section is a document type. Source systems are the `source`
    documents whose title has «:» — the system's name is the part before it, its key comes from the document's
    `sys-<key>` tag. `integration`: the system of the first `consumes` target that is a source system document, else
    the system named by the first tag equal to a system key (`<key>` or `sys-<key>`), else «Общие правила»
    (`integration/_common`). `standard`: a `template` / `шаблон` tag → «Шаблоны документов» (`standard/templates`),
    else «Регламенты и качество» (`standard/rules`). Other sections have no groups: their documents are in the
    section's `doc_ids`, and each document's `group` is `null`. A one-document group is kept. Group keys are
    `<section>/<system key>` (a system without a key: `<section>/<lower-cased document id>`); non-system groups start
    with `_` or are fixed words. An explicit `parent` can later become the first resolver of `GROUP_RESOLVERS`.
  - **`systems`.** The systems of the document's `consumes` / `produces` targets that are source system documents,
    then the systems its tags name (`<key>` or `sys-<key>`; so a system's own profile names it), without repeats, in
    that order.
  - **Order.** Sections: Продукт, Архитектура, Домен, Системы-источники, Интеграции, Датасеты, Процессы, Решения,
    Стандарты, Руководства, Глоссарий (a type outside this list last); empty sections are left out. Groups by name,
    «Общие правила» last. Documents in a group or section: those needing attention first, then by title.
  - Declared before `GET /api/documents/{id}`: the path `tree` is never read as a document ID.
- `GET /api/documents/{id}` -> `DocumentDetail` with rendered-safe markdown/source content, frontmatter metadata and revision.
- `GET /api/search?q=...&source=team,corporate&limit=10` -> ranked `SearchResult[]`.

```json
{
  "id": "SEM-INT-ARIS-001",
  "title": "ARIS metadata integration overview",
  "type": "integration",
  "status": "draft",
  "owner": "semantic-layer-team",
  "source": "local",
  "source_uri": "local://SEM-INT-ARIS-001",
  "revision": "example-synthetic-revision",
  "tags": ["aris", "metadata"],
  "excerpt": "A clearly marked synthetic demonstration...",
  "is_demo": true
}
```

## 3. Assistant
`POST /api/assistant/ask`

```json
{
  "question": "Какие есть ограничения интеграции ARIS?",
  "sources": ["team", "corporate"],
  "include_drafts": false
}
```

Response:

```json
{
  "answer": "В доступных документах нет подтверждённых ограничений интеграции ARIS.",
  "mode": "mock",
  "confidence": "insufficient_evidence",
  "citations": [],
  "warnings": [],
  "provenance": {"overall": "none", "synthetic": 0, "not_synthetic": 0, "unknown": 0, "by_kind": {}}
}
```

Synthetic origin of the sources is metadata (`provenance`, `Citation.provenance`), not a fixed warning — see
«Answer provenance» below.

In actual `internal_api` mode, model synthesis must use only retrieved authorized context, and the citations list must be checked against the retrieval set. `confidence` is a descriptive status (`supported|partial|insufficient_evidence`), not a model-generated probability.

## 4. Drafts and proposals
- `POST /api/drafts` -> `{document_id, base_revision, proposed_content, reason}` creates local proposal, never overwrites source.
- `GET /api/drafts/{draft_id}` -> metadata, validation errors and diff.
- `POST /api/drafts/{draft_id}/reject` -> rejected state.
- `POST /api/drafts/{draft_id}/mark-ready` -> ready-for-review state; source remains unchanged.
- `POST /api/drafts/{draft_id}/submit` -> GitLab branch + commit + MR (feature flag `GITLAB_PROPOSALS_ENABLED`); `refresh-status` reads the MR state. See "Implemented contract (v0.2)".

Conflict detection: creating/opening MR must fail with `409 Conflict` if current source revision differs from the draft's `base_revision`.

## 5. Standard errors
Use structured errors `{code, message, request_id}` and appropriate HTTP status (400 invalid, 401 unauthenticated, 403 forbidden, 404 unknown, 409 revision conflict, 422 invalid schema, 503 disabled integration). Do not leak credentials or raw internal API payloads.

## 6. Python provider protocols (example, not rigid code)

```python
from typing import Protocol

class KnowledgeRepository(Protocol):
    async def list_documents(self, filters): ...
    async def get_document(self, document_id: str): ...

class CorporateKnowledgeConnector(Protocol):
    async def search(self, query: str, user_context): ...
    async def get_page(self, page_id: str, user_context): ...

class AIProvider(Protocol):
    async def answer(self, question: str, citations_context: list, options): ...

class ProposalPublisher(Protocol):
    async def publish_proposal(self, proposal, user_context): ...
```

No externally visible endpoint may implicitly call a live corporate system when the provider is configured as disabled/mock. Document config flags and provider behavior.

## Implemented contract (v0.1)

Refinements made during implementation (the schema is served at `GET /api/openapi.json`; the browser UI for it is disabled because it would load scripts from a public CDN):

- `GET /api/health` → `{status, mode, version}`. `GET /api/session` → demo identity, auth mode and feature flags for the UI.
- `GET /api/documents` accepts comma-separated values for `type`, `status`, `owner`, `source`, `tag`; unknown enum values → `400 invalid_filter`. Items add `review_state` (`ok|stale|never_reviewed|not_required`), `owner_missing` and, for text queries, `highlights` (segments `{text, highlight}` — never HTML).
- `GET /api/documents/{id}` adds `content_html` (server-sanitized; heading `id`s equal citation `section_anchor`s), `sections`, `related` (resolved or not), `warnings`, `path`. Invalid ID → `400`, unknown → `404`, duplicated ID → `422 duplicate_document_id`.
- `GET /api/knowledge/facets` and `GET /api/knowledge/issues` (files that failed validation and are therefore hidden).
- `GET /api/search` returns an object instead of a bare array: `{query, items: SearchResult[], total, scopes: [{scope, state, message}], warnings}` so a disconnected corporate scope is reported explicitly. `SearchResult` adds `excerpt_segments`, `section`, `section_anchor`, `score`.
- `POST /api/assistant/ask` request also accepts `include_deprecated`; unknown fields → `422`. The response adds `excluded_sources` (drafts/deprecated documents that matched but were not used as evidence), `scopes` and `unmatched_terms`. `Citation` = `{ref, source_type, document_id, title, source_uri, revision, status, section, section_anchor, excerpt, retrieved_at, is_demo, app_path}`; `[n]` markers in `answer` always refer to `ref`. `AI_PROVIDER=disabled` → `503 assistant_disabled`.
  Citation rules enforced by the server for every provider: a citation exists only if the provider listed it in its structured evidence **with a verbatim quote (≥ 12 characters) found in the retrieved passage**; bare `[Cn]` markers never create citations; unknown or unverifiable references are dropped with a warning and downgrade `supported` to `partial`; with no verified citation the answer becomes `insufficient_evidence` and model-written text is replaced by a fixed server message. Before reaching any provider, passage text has bracketed markers neutralized (`[C2]` → `(C2)`) and sentences that look like instructions to an AI replaced by a visible placeholder; passage metadata is sent as JSON.
- Drafts (v0.1, superseded by v0.2 below): statuses were `open → ready_for_review | rejected`, `ready_for_review → rejected | submitted`. `submitted` means a GitLab MR exists (set by `open-mr`); from then on rejecting or merging happens only in GitLab, and a closed MR is never re-created. `POST /api/drafts` also accepts `origin` (`manual|ai_suggestion`) and returns `201` with the full detail (diff in `unified` text and structured `lines`, `validation`, `history`, `is_stale`, `can_mark_ready`, `can_reject`, `publication`). A draft with validation errors is stored but `mark-ready` → `422 validation_failed`. `GET /api/drafts?status=&document_id=` lists drafts. `POST /api/drafts/suggest` asks the AI provider for a proposed text (not stored; `503 ai_edit_unsupported` in mock mode). `POST /api/drafts/{id}/open-mr` → `503 gitlab_proposals_disabled` unless enabled; `409` when not ready or when the source revision changed.
- `GET /api/corporate/pages/{page_id}` reads one page through the corporate connector (`503` when disabled, `404` for unknown or unauthorized pages — indistinguishable on purpose).
- Every state-changing request must carry `X-SKH-Client` (`403 csrf_header_missing`); requests with a non-allowlisted `Host` → `400 host_not_allowed`.

## Implemented contract (v0.2, M4.5)

Changes on top of v0.1 (OpenAPI checked by `tests/test_knowledge_rules.py::test_openapi_contract_lists_documented_endpoints`):

- **Provenance on documents.** `DocumentSummary`/`DocumentDetail` add `web_url` (link to *this revision* in the source system; host must equal `GITLAB_URL`; `null` for the local workspace) and `index_state` (`current|stale` — `stale` means the last sync could not refresh the document and its last successfully read revision is shown). `updated_at` = commit date of the revision (GitLab) or file mtime (local); never guessed.
- **Sorting.** `GET /api/documents?sort=relevance|title|updated|status` (`updated` = newest first, undated last; since UI v2 round 2 by the front-matter `metadata_updated_at`, see §2); unknown values → `422`.
- **Synchronisation.** `GET /api/index/status` and `POST /api/index/sync` (full re-sync; `X-SKH-Client` required) → `SyncStatus {source, state: fresh|stale|error|never_synced, message, documents, issues, failed_paths[], last_attempt_at, last_success_at, source_version, branch, head_commit, indexed_documents, indexed_version, indexed_at}`. `POST` returns `503` with the source error code when the source cannot be read.
- **Proposal lifecycle.** `ProposalStatus = draft | ready_for_review | submitting | submitted_to_gitlab | merged | rejected | conflict | submission_failed` (stores from v0.1 are migrated: `open→draft`, `submitted→submitted_to_gitlab`). The GitLab MR state is separate: `merge_request {iid, url, state: opened|merged|closed|locked|unknown, source_branch, target_branch, checked_at}`. `ProposalDetail` adds `can_submit`, `can_refresh_status`, `source_document_state` (`unchanged|changed_since_base|updated_by_this_proposal|missing`), `branch_name`, `submission {attempts, last_attempt_at, error_code, error_message, uncertain}`; `ProposalSummary` adds `merge_request_url`, `merge_request_state`.
  - `POST /api/drafts/{id}/mark-ready`: re-checks the revision at the source; stale → `409 revision_conflict` and status `conflict`.
  - `POST /api/drafts/{id}/submit` (alias `open-mr`, deprecated): allowed from `ready_for_review`, `submission_failed` or an interrupted `submitting` (> 5 min). Re-validates, re-checks the revision, then branch `kb/update/<ID>-<8 hex>` → commit → MR. Idempotent: an existing MR of the branch is reused. Errors: `409 revision_conflict` (→ `conflict`), `409 gitlab_branch_conflict` (foreign branch, untouched), `409 submission_in_progress`, `422 validation_failed`, `502` (retryable GitLab failure, incl. `gitlab_write_uncertain`), `503` (`gitlab_proposals_disabled`, auth/permission errors). On 502/503 the proposal becomes `submission_failed`; `details.proposal_preserved = "true"`.
  - `POST /api/drafts/{id}/refresh-status`: reads the MR from GitLab. `merged` (only when GitLab reports it; then the knowledge source is re-synchronised) or `rejected` (MR closed). For an `uncertain` failed submission it adopts an MR that was created although the answer was lost, or clears the flag.
  - `POST /api/drafts/{id}/reject`: allowed from `draft`, `ready_for_review`, `submission_failed` (not while `uncertain` → `409 submission_uncertain`).
  - History actions: `created, marked_ready_for_review, rejected, conflict_detected, submission_started, submission_failed, merge_request_opened, merge_request_found, merge_request_checked, merged_in_gitlab, merge_request_closed`.
- **Authorization.** Every route except `/api/health` declares an action (`app/authz.py`); a refusal is `403 forbidden` with `details.action`. `GET /api/session` adds `authorization_policy` and `features.ai_provider`.
- **Repository protocol** (`backend/app/adapters/knowledge/base.py`): `snapshot`, `get_document`, `get_document_at_revision` (`RevisionNotAvailableError`), `exists`, `current_revision` (fresh, bypasses caches), `refresh(full)`, `sync_info`, `status`. Publisher protocol (`publishers/base.py`): `branch_for`, `publish_proposal → PublishResult{created|existing|conflict}`, `merge_request_state`, `status`; failures raise `PublicationError{code, uncertain, retryable}`.

## Implemented contract (v0.3, M4.6 + M4 + M5)

Changes on top of v0.2. All routes require an `Action` (`app/authz.py`); state-changing routes require
`X-SKH-Client`. Errors keep the shape `{code, message, request_id, details?}`. Nothing in this section was
validated against real GitLab/Confluence — only against the stateful test doubles.

### Authoring of new documents

`NewDocumentMetadata` (extra fields forbidden): `id` (1–128), `title` (1–300), `status`
(`draft` default; `deprecated` is rejected by validation), `owner` (1–100), `tags[]` (≤ 30), `related_ids[]`
(≤ 50), `source_refs[]` (≤ 50), `summary?` (≤ 1000). The type is taken from the template; the server
generates the front matter (`docs/DOCUMENT_TEMPLATES.md`).

| Route | Action | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/authoring/templates` | `read_knowledge` | — | `DocumentTemplateInfo[]`: `{id, title, description, doc_type, id_prefix, default_tags[], sections[], skeleton, suggested_id, suggested_path}`; `suggested_id` skips IDs of documents and unfinished `create` proposals | `503` (knowledge source code) |
| `POST /api/authoring/check` | `create_proposal` | `{template_id, metadata, body, path?, origin: manual\|ai_suggestion, exclude_proposal_id?}` | `{content, path, validation: ValidationIssue[], preview_html, id_available, path_available, error_count, warning_count}`; nothing is stored; a taken ID/path is reported in `validation`, not as an HTTP error | `404 template_not_found`, `422`, `503` |
| `POST /api/authoring/ai-draft` | `create_proposal` | `{template_id, title (1–300), request (3–2000), related_ids[] (≤ 10)}` | `AiDraftResponse {mode, body, references[{document_id, title, revision, status, source, is_demo}], citations[{document_id, title, revision, status, section, quote}], unverified_claims[], warnings[], insufficient_data, suggested_related_ids[], access_scope}`; not stored (`docs/AI_AUTHORING_CONTRACT.md`) | `404 template_not_found`, `503 ai_authoring_unavailable`, `503 assistant_disabled\|ai_misconfigured`, `502` other provider errors (e.g. `ai_invalid_response`), `503` source unavailable |
| `POST /api/authoring/drafts` | `create_proposal` | `{template_id, metadata, body, path?, reason (3–2000), origin}` | `201 ProposalDetail` with `operation=create`, `status=draft`, `base_revision=""`, `edit_version=1`; a draft with other validation errors is stored with them | `409 document_id_taken\|document_path_taken` (`details.field` = `id`\|`path`, `details.validation`; **nothing stored**), `404 template_not_found`, `422`, `503 authoring_unavailable` / source unavailable |

### Editable drafts

| Route | Action | Request | Response | Errors |
|---|---|---|---|---|
| `PUT /api/drafts/{id}` | `create_proposal` | `DraftUpdate {expected_version (≥ 1), reason?, origin?}` plus `proposed_content` (operation `update`) **or** `metadata` + `body` + `path?` (operation `create`) | `200 ProposalDetail`, `edit_version` + 1; for `update` the base revision is unchanged | `404 proposal_not_found`, `409 draft_not_editable` (status ≠ `draft`), `409 draft_modified` (stale version, `details.current_version`), `409 document_id_taken\|document_path_taken` (create), `422 validation_failed` (fields missing for the operation), `404 document_not_found` (update) |
| `DELETE /api/drafts/{id}` | `create_proposal` | — | `204`; the content-free audit trail is kept | `404 proposal_not_found`, `409 draft_not_deletable` (allowed only for `draft`, or `conflict` with no submission attempt and no MR) |

### Blank documents and «Применить шаблон» (additive)

Templates structure documents; they do not gate their creation (`docs/TEMPLATE_HUB.md`). Without the new fields
every request and response is the same as before.

- `template_id` is **optional** in `POST /api/authoring/drafts`, `POST /api/authoring/check` and
  `POST /api/documents/import` (with `metadata`). Without it the document is **blank**: the server allocates
  `SEM-DOC-NNN` (once, immutable), writes `status: draft`, `owner: unassigned` when empty, origin `manual`
  (`import` for an import) and **no** `template` / `template_version`; free Markdown — no required sections, the
  body / size / secret / PII / unsafe-markup rules stay.
- `NewDocumentMetadata.type?` (`DocType`): the section of a blank document; on creation empty → `guide`, on a
  save empty → the draft's own type. For a template document it must be the template's type or absent, else
  `422 template_type_mismatch` (`details.field = "type"`). Unknown values are `422` (only the existing types).
- A `create` draft saved from the editor keeps every YAML key the form does not manage (`relations`,
  `aliases`, `reviewed_at`, `synthetic`, unknown keys…), so an imported file opened in the editor loses nothing.
- `POST /api/documents/import/preview` without any active template: a blank `SEM-DOC-NNN` preview (`template`
  field `missing`, `type` suggested `guide`) instead of `409 no_active_template`.

| Route | Action | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/authoring/blank` | `read_knowledge` | — | `BlankDocumentInfo {id_prefix: "SEM-DOC", suggested_id, suggested_path, default_type: "guide"}`; the ID is a preview only | `503` source unavailable |
| `POST /api/drafts/{id}/apply-template/preview` | `create_proposal` | `{template_id}` | `TemplateApplyPreview` (below); nothing stored | `404 proposal_not_found\|template_not_found`, `409 draft_not_editable` (status ≠ `draft`), `409 template_not_active` (draft / deprecated / archived / hidden template), `422 template_apply_invalid_document` |
| `POST /api/drafts/{id}/apply-template` | `create_proposal` | `{template_id, template_version, expected_version}` | `200 ProposalDetail`: `create` draft — `template_id` / `template_version` re-pinned, text updated, `edit_version` + 1; `update` draft — `proposed_content` updated through the usual save. History `template_applied` | the preview's errors + `409 draft_modified` (`details.current_version`), `409 template_version_changed` (the active version is not the previewed one; `details.current_version`), `409 template_apply_no_change` |
| `POST /api/documents/{id}/apply-template/preview` | `create_proposal` | `{template_id}` | `TemplateApplyPreview` with `base_revision`; nothing stored | `404 document_not_found\|template_not_found`, `409 template_not_active`, `422`, `503` |
| `POST /api/documents/{id}/apply-template` | `create_proposal` | `{template_id, template_version, base_revision, reason? (3–2000)}` | `201 ProposalDetail` — a CHANGE proposal (`operation=update`, `status=draft`, default reason «Применить шаблон «…» vN»); **the document itself is not modified** | `409 revision_conflict` (`details.current_revision`, `base_revision`), `409 template_version_changed`, `409 template_not_active`, `409 template_apply_no_change`, `404` |

`TemplateApplyPreview`: `{target: draft|document, document_id, draft_id?, expected_version?, base_revision?,
template_id, template_version, template_title, previous_template_id?, previous_template_version?, type_before?,
type_after, sections[{heading, template_heading?, state: matched|added|kept|optional_missing, required}],
content_before, content_after, diff: DiffResult, changed, validation[]}`. Applying keeps every existing line in
order (the body only gains lines), maps `##` headings to template sections by title (case and surrounding spaces
ignored), adds the skeleton («Требует уточнения») of each missing **required** section after the nearest preceding
template section present, keeps unknown sections, and rewrites only the `type`, `template` and `template_version`
lines of the YAML (the ID never changes).

### Proposal changes

- `ProposalSummary.operation`: `create | update` (stores from earlier builds are migrated to `update`).
- `ProposalDetail` adds `template_id`, `edit_version`, `can_edit` (`status == draft`), `can_delete`,
  `new_document {metadata, body}` (form view of a `create` proposal, parsed from the stored Markdown),
  `merged_revision` (revision of the document on the knowledge branch after the confirmed merge and sync),
  `synced_at`.
- `source_document_state` adds `new_document` (create: the document does not exist yet — expected before
  merge), `id_taken` (create: a document with this ID appeared before the merge) and `merged_pending_sync`
  (GitLab confirmed the merge, the knowledge base has not been re-synced yet). `can_refresh_status` is also
  `true` for `merged` proposals without `merged_revision` (retries the post-merge sync).
- `create` proposals: the diff is a single hunk `@@ -0,0 +1,N @@` adding every line; `mark-ready` and
  `submit` re-check ID/path against a fresh read of the source — taken → `409 document_exists`, status
  `conflict`, nothing written; the GitLab commit uses one `create` action without `last_commit_id`, trailers
  `Proposal-Id`, `Operation: create`; MR title `Draft: [новый] <ID> — …`.
- History actions add `created_new_document`, `draft_saved`, `draft_deleted` (audit only), `knowledge_synced`.

### Session and integration status

- `GET /api/session` → `features.ai_authoring` (`true` when the AI provider is not disabled and supports
  `draft_document`). `features.confluence_publish` is `true` when a Confluence REST publisher is
  **configured** (also in dry-run-only mode); whether writes are allowed is `publisher.mode` in the
  document publication status.
- `GET /api/integrations/status`: every item adds `target` (`none|local|mock|real`), `access`
  (`none|read|write|read_write`) and `checked_at`; the response adds `checked_at`. New item
  `confluence_publisher` ("Confluence Data Center (REST, публикация)"): `state=connected` only after reading
  the space and the parent page; capabilities `read_pages`, `dry_run` and, with writes enabled,
  `create_page`, `update_page`. `target=real` never means live-validated.

### Publication (M5)

No publication route accepts a request body, a page ID, a space or a URL; the target comes from
configuration only.

| Route | Action | Response | Errors |
|---|---|---|---|
| `GET /api/documents/{id}/publication` | `read_knowledge` | `DocumentPublicationStatus` | `400 invalid_document_id`, `404 document_not_found`, `422 duplicate_document_id`, `503` source unavailable |
| `POST /api/documents/{id}/publication/prepare` | `prepare_publication` | `PublicationJobDetail` — job for the **current** revision (reused if one is active for it; an active job of an older revision becomes `superseded`), then a dry-run | `503 publication_disabled`, `409 publication_in_progress` (`details.job_id`; a job is `publishing`/`result_unknown`), `409 invalid_transition`, `502`/`503` `confluence_*` or GitLab errors (the job stays `pending`), plus the document errors above |
| `GET /api/publications/jobs?document_id=` | `read_knowledge` | `{items: PublicationJobSummary[], total}` (newest first, ≤ 50) | — |
| `GET /api/publications/jobs/{job_id}` | `read_knowledge` | `PublicationJobDetail` | `404 publication_job_not_found` |
| `POST /api/publications/jobs/{job_id}/dry-run` | `prepare_publication` | `PublicationJobDetail` (read requests only) | `503 publication_disabled`, `404`, `409 invalid_transition`, `502`/`503` |
| `POST /api/publications/jobs/{job_id}/publish` | `publish_confluence` | `PublicationJobDetail` in its final state: `published`, or `failed` / `conflict` / `result_unknown` for write failures (still HTTP `200`) | `503 publication_disabled`, `503 publish_disabled` (writes off), `404`, `409 invalid_transition` (not `dry_run_ready`), `409 plan_changed` (`details.state`; the stored plan was refreshed, nothing written), `409 publication_in_progress`, `502`/`503` `confluence_*` or GitLab errors while re-planning before the write (job stays `dry_run_ready`); an unexpected server error during the write is `500` and leaves the job `result_unknown` |
| `POST /api/publications/jobs/{job_id}/reconcile` | `prepare_publication` | `PublicationJobDetail`: for `result_unknown` — read-only inspection (`published` if the write is confirmed, otherwise `failed` + fresh dry-run); for `failed`/`conflict` — fresh dry-run | `503 publication_disabled`, `404`, `409 invalid_transition`, `502 confluence_write_uncertain` (inspection impossible; job stays `result_unknown`) |
| `POST /api/publications/jobs/{job_id}/release-missing-page` | `publish_confluence` | `PublicationJobDetail` after a fresh dry-run (action `create`); allowed only for a `mapped_page_missing` conflict when the page is verified absent; the mapping is forgotten, nothing is written | `503 publication_disabled`, `404`, `409 invalid_transition` / `page_exists`, `502` if Confluence cannot be read |
| `POST /api/publications/jobs/{job_id}/acknowledge-manual-edit` | `publish_confluence` | `PublicationJobDetail` after a fresh dry-run; the current page becomes the mapping baseline, nothing is written to Confluence | `503 publication_disabled`, `404`, `409 invalid_transition` (not a `manual_edit` conflict, or page/mapping missing) |

Confluence errors during dry-run map to `503` when not retryable (`confluence_auth_failed`,
`confluence_forbidden`, `confluence_bad_request`) and `502` otherwise (`confluence_unavailable`,
`confluence_timeout`, `confluence_unreachable`, `confluence_rate_limited`, `confluence_not_found`,
`confluence_invalid_response`, `confluence_response_too_large`).

Shapes:

```text
DocumentPublicationStatus {
  document_id, current_revision, state: disabled|not_published|pending|validating|dry_run_ready|publishing|
         published|outdated|conflict|failed|result_unknown,
  message, publisher {mode: disabled|dry_run_only|write, target_kind: none|local|mock|real, space_key, parent_id, message},
  mapping {page_id, space_key, parent_id, page_title, page_version, published_revision, last_published_at, url} | null,
  latest_job: PublicationJobSummary | null, can_prepare }

PublicationJobSummary {
  id, document_id, document_path, revision, state: pending|validating|dry_run_ready|publishing|published|
  conflict|failed|result_unknown|superseded, action: create|update|noop|conflict|null, proposal_id,
  created_at, updated_at, attempts, error_code, error_message, uncertain, page_id, version_after, published_at }

PublicationJobDetail = PublicationJobSummary + {
  plan: PublicationPlan | null, history: [{at, actor, action, state, revision}],
  can_dry_run, can_publish, can_reconcile, publish_enabled, publish_disabled_reason }

PublicationPlan {
  action, revision, target {space_key, parent_id, page_id, title, url}, storage, diff,
  diff_kind: new_page|page_update|manual_edit|none, warnings: ValidationIssue[], problems: ValidationIssue[],
  remote_version, rendered_hash, merge_request {iid, url, merged_at} | null, checked_at }
```

Problem codes: `revision_superseded`, `not_merged`, `status_not_publishable`, `space_not_found`,
`parent_not_found`, `unsafe_link`, `mapped_page_missing`, `foreign_page`, `title_taken`, `page_moved`,
`manual_edit`. Warning codes: `frontmatter_page_id_ignored`, `managed_page_found`, `version_changed`,
`image_not_published`, `diagram_as_code`, `internal_link_as_text`, `link_as_text`, `raw_html_as_text`,
`list_start_ignored`. Semantics: `docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md`, `docs/CONFLUENCE_MAPPING.md`.

### Authorization additions

| Action | Routes |
|---|---|
| `create_proposal` | + `POST /api/authoring/check`, `POST /api/authoring/ai-draft`, `POST /api/authoring/drafts`, `PUT /api/drafts/{id}`, `DELETE /api/drafts/{id}`, `POST /api/drafts/{id}/apply-template[/preview]`, `POST /api/documents/{id}/apply-template[/preview]` |
| `read_knowledge` | + `GET /api/authoring/templates`, `GET /api/authoring/blank`, `GET /api/documents/{id}/publication`, `GET /api/publications/jobs*` |
| `prepare_publication` (new) | `POST …/publication/prepare`, `POST …/dry-run`, `POST …/reconcile` — Confluence reads only |
| `publish_confluence` (new) | `POST …/publish`, `POST …/acknowledge-manual-edit`, `POST …/release-missing-page` |

### Provider and publisher protocols

- `AIProvider` adds `supports_authoring` and `draft_document(AuthoringRequest) -> AuthoringDraft`
  (`backend/app/adapters/ai/base.py`).
- `ProposalForPublication.operation`: `create | update` (`base_revision` empty for `create`).
- `ConfluencePublisher` (`backend/app/adapters/publishers/base.py`): `enabled`, `write_enabled`, `mode`,
  `target_kind`, `space_key`, `parent_id`, `property_key`, `page_url`, `read_space`, `read_page`, `find_pages`,
  `read_marker`, `create_page`, `update_page`, `write_marker`, `status`; failures raise `PublicationError`
  (`uncertain`, `retryable`).
- `KnowledgeRepository` protocol adds `file_exists(path)` (local and GitLab; fresh read for ID/path checks); `GitLabKnowledgeRepository` adds `merged_merge_request(revision)` (merge evidence for publication).

## Implemented contract (v0.4, UI v2 phase C: assistant skills and attachments)

Source: `docs/ui-v2/specs/02_ASSISTANT.md` §3–§6. Additive: every new request field is optional and every new
response field has a default, so a v0.3 request gets exactly the v0.3 answer (deterministic eval unchanged).
Code: `app/domain/skills.py`, `app/services/skills.py`, `app/services/attachments.py`, `app/api/multipart.py`,
`app/api/assistant.py`; tests `tests/test_assistant_skills.py`, `tests/test_attachments.py`.

| Route | Action | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/assistant/skills` | `ask_assistant` | — | `SkillInfo[]` in a fixed order | — |
| `POST /api/assistant/attachments` | `ask_assistant` | `multipart/form-data`: `conversation_id`, `file` (send `conversation_id` first) | `201 AttachmentInfo` (`status: ready`) or `200 AttachmentInfo` (`status: error` + `error_code`, nothing stored) | `422 invalid_request` (`details.fields[].loc` = `body.conversation_id` / `body.file`), `422 invalid_multipart`, `503 assistant_disabled` |
| `DELETE /api/assistant/attachments/{attachment_id}` | `ask_assistant` | — | `204` — idempotent (also for an expired, deleted or never stored id) | `422` (id is not `ATT-<16 hex>`) |
| `POST /api/assistant/ask`, `/ask/stream` | `ask_assistant` (+ `create_proposal` for workflow skills, `read_corporate` for `corporate`) | v0.3 body + the fields below | `AskResponse` + `skill`, `proposal`; citations may have `source_type: attachment` | see below |

Shapes:

```text
SkillInfo { id, name, description, access: read|draft,
            requires: {document: bool, selection: bool, attachment: bool,
                       document_or_question: bool},   (document_or_question: review round, default false)
            prompt_optional: bool, available: bool, unavailable_reason: string|null }

AttachmentInfo { id: "ATT-<16 hex>", conversation_id, name (display only, sanitized), size, mime,
                 status: ready|error, summary: string|null («3 листа», «12 страниц», «1 240 строк»),
                 error_code: unsupported_type|too_large|limit_reached|unreadable|null,
                 expires_at: datetime|null (null for an error result) }

AskRequest += { conversation_id?: ^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$ (required with attachment_ids),
                skill_id?: string, attachment_ids?: string[≤10], context_document_ids?: string[≤5],
                selection?: {document_id, section_anchor?, text? (≤ 8000, "" = the whole section)} | null }
                question: ≥ 3 characters, or "" when the skill has prompt_optional

AskResponse += { skill: {id, name, access} | null      (echoed when the request named a skill)
                 proposal: {id, kind, status, graph_link?} | null   (workflow skills; GET /api/ai/proposals/{id}) }

Citation   += { source_type: local|gitlab|confluence|attachment,
                attachment_id?, attachment_name?, locator? («строка 1», «стр. 4», «лист Fields, строка 12», «строки 3–5») }
                for an attachment: document_id = attachment id, source_uri = attachment://<id>, status/section/app_path = null
Citation   += { excerpt_parts?: ExcerptPart[] | null }        (round 2, additive; team documents only)
ExcerptPart  = { kind: "text", text } | { kind: "table", headers: string[], rows: string[][] }
```

**Table excerpts (`excerpt_parts`).** `excerpt` stays the verbatim quote the server verified against the passage (a
table's cells appear glued there: section text, the search index and the provider input are unchanged). When that
quote touches a Markdown table of the cited section, the server traces it back word by word to the section's Markdown
at the same revision and adds `excerpt_parts`: the quote's own prose and, for each table it touches, the header row and
the touched body rows (complete rows, cells as plain text; an escaped `\|` is a `|` in the cell, the alignment row is
not a row, an empty cell is `""`). Several pieces of a quote joined by « … » keep a `…` between them. No table touched,
or no confident match (e.g. a redacted fragment) → `null`, and the UI shows `excerpt` as before. Set for ask answers
and for the evidence citations of workflow skills; never for Confluence pages or attachments.

**Not found terms (`unmatched_terms`, round 2).** Words of the question that no allowed source contains — never
function words (prepositions, conjunctions, particles, pronouns, auxiliary verb forms: `FUNCTION_WORDS` in
`app/domain/text.py`, a documented RU + EN superset of the search stop words). The same filter applies to the demo
provider's note «В процитированных фрагментах не встречаются: …» and to the «не встречаются» lists of insufficient
answers. An empty list means nothing meaningful is missing: the UI then shows no «Не найдено в документах» line.
Search terms, coverage counting and answer decisions are unchanged (function words still count; they are only never
named).

**Skills and AI modes.** `internal_api`, `claude_cli`: all available. `mock`: all except `improve_section`
(`unavailable_reason`: «Нет языковой модели (режим mock): переписать раздел нельзя.» — the mock can only normalize
layout). `disabled`: none available, reason «ИИ отключён». `draft_document` additionally needs a provider with
`supports_authoring`.

**Attachments.** ≤ 10 ready files per conversation (≤ 100 per user over all conversations), ≤ 20 MB each; formats
md/markdown, txt, csv, json, yaml/yml, sql, pdf, docx, xlsx; text extraction only. `unsupported_type`: another
extension, an executable by content (PE/DOS, ELF, Mach-O, universal binary / Java class, WebAssembly, `#!` script —
also under a text extension), a docx/xlsx carrying a macro project or executable entries. `too_large`: > 20 MB (a
body beyond 20 MB + 64 KiB is not read to the end). `limit_reached`: the limits above. `unreadable`: corrupt,
encrypted, without a text layer, binary under a text extension, empty, zip-bomb guard (entries, total and per-entry
uncompressed size, ratio) or extraction over 20 s. Text: UTF-8 (BOM), UTF-16 with BOM, CP1251 fallback; units are
lines (text, pdf pages), paragraphs and table rows (docx), rows (xlsx, ≤ 50 sheets); ≤ 300 000 characters kept
(`summary` then ends with «, текст сокращён»). The body is read by `python-multipart`'s streaming parser under a hard
byte cap checked before each chunk is parsed (never spooled to a temporary file; malformed bodies → `422
invalid_multipart` with a message that never quotes the body). Only the extracted text is stored (app-state SQLite, table
`assistant_attachments`), never the bytes; the file name never touches the filesystem; contents are never logged.
Expiry: `ATTACHMENTS_TTL_HOURS` (default 24); expired rows are purged on access. Attachments are visible only in
their conversation and to their uploader, never indexed into search, the graph or the discovery memory. With
`AI_PROVIDER=disabled` uploads are refused (`503 assistant_disabled`; the UI has no file button then).

**Ask errors (HTTP before any stream event).** `503 assistant_disabled`; `422 skill_unknown`; `503 skill_unavailable`
(`details.skill_id`, message = the reason); `422 skill_input_missing` (`details.missing`: `document` | `selection` |
`attachment` | `document_or_question`; `find_related` needs a document or a question, `improve_section` a selection
with `section_anchor`);
`404 attachment_not_found` (unknown, expired, deleted, another conversation or user — indistinguishable on purpose);
`404 document_not_found` (chosen document or selection document not visible); `422 selection_not_found` (the
selected text is not verbatim in the document / section, or the anchor does not exist); `403 forbidden`; `422
invalid_request` (validation). Provider failures keep the v0.3 behaviour (HTTP error on `/ask`, `error` event on
the stream).

**Evidence rules.** Chosen documents (best sections for the question) and the verified selection are handed to the
provider first, marked `chosen`, and quoted first when they contain a question term; a chosen document that is a
draft keeps its status in the citation and the usual warning. Attachment fragments are a separate group (header line
+ windows around matching lines, ≤ 4 000 characters per answer, own budget); a citation of a fragment exists only
with a verbatim quote, and its `locator` is computed by the server from the cited lines. An answer cited only from
attachments is never `supported` (capped at `partial`, warning «Ответ опирается только на вложение…»). With
attachments, the discovery trace stores only the user's own question (never the file's words or name).

**Skills.** `answer` (default), `explain` (ask with «Объясни: …» over the selection / document), `compare_with_file`
(ask; the file header joins the retrieval text; absent terms are reported, not a refusal) run through the grounded
ask pipeline: `proposal = null`. The others call `AiWorkflowService.propose` (M5.6.3) and return `proposal`:
`summarize` → `summarize`, `check_completeness` → `check_completeness`, `check_freshness` → `impact_analysis`,
`find_related` → `find_related` (one document, or the best approved document for a question) / `explain_relation`
(two documents), `draft_document` → `draft_from_prompt`, `improve_section` → `improve_section`, `suggest_metadata`
→ `suggest_metadata`. For them `answer` = the proposal summary, `citations` = the proposal's evidence quotes
re-verified verbatim against the reader's snapshot, `confidence` = `insufficient_evidence` when the proposal is
insufficient, `supported` with verified citations, otherwise `partial`. Nothing is applied: Accept / Reject stay
`POST /api/ai/proposals/{id}/accept|reject`. On `/ask/stream` a workflow skill sends `status` retrieving →
generating → validating and `final` (no `delta`).

### v0.4 additions (UI v2 review round)

Additive: without the new parameters every response is the same as before.

**Proposals list filters.** `GET /api/drafts` (`read_knowledge`) adds two optional boolean query parameters that
combine with `status` and `document_id` (AND):

| Parameter | Default | Effect | Used by |
|---|---|---|---|
| `exclude_own` | `false` | leaves out the caller's own proposals (`author == user_id`): nobody reviews their own change | «Ревью»: `?status=ready_for_review&exclude_own=true` (sidebar badge, the list behind it, the home «Ждёт вашего решения») |
| `open_only` | `false` | only open proposals (`OPEN_STATUSES` in `app/domain/proposals.py`): `draft`, `ready_for_review`, `submitting`, `submitted_to_gitlab`, `submission_failed`. Closed for good: `merged`, `rejected` (also an MR closed without merge), `conflict` (the base changed; a new proposal is needed). There is no withdrawn / applied status. | the sidebar «Предложения» count and its «Открытые» list |

A non-boolean value is `422 invalid_request`. In demo single-user mode every proposal is the caller's own, so
the «Ревью» list is usually empty (no badge).

**Skill rename.** `check_freshness` is named «Что перепроверить», description «Покажет связанные документы, которые
могли устареть» (the id and the `impact_analysis` scenario behind it are unchanged).

**«One of» requirement.** `SkillInfo.requires.document_or_question` (default `false`, so older clients and skills
are unaffected): the skill needs a chosen document / a selection in one **or** a question of at least 3
characters. Only `find_related` sets it. Without either, `/ask` answers `422 skill_input_missing` with
`details.missing = ["document_or_question"]` (message «… нужно: документ или вопрос.»); the composer disables
sending and says the same in one line.

## Implemented contract (v0.5, M5.7: AI-native system awareness)

Additive only; every v0.4 field and behaviour is unchanged. Design, semantics and limits: `docs/AI_NATIVE_TOOLS.md`.

| Route | Change |
|---|---|
| `POST /api/assistant/ask` | request: `history[i].context?: TurnFactContext[]` (≤ 5, the referent of that answer); response: `system_facts`, `tool_steps`, `general_knowledge`, `conversation_context` |
| `POST /api/assistant/ask/stream` | new events `tool_call {call_id, round, tool, operation}` and `tool_result {call_id, step}`; `status: generating` carries `round`; `final` = the response above |

- `SystemFact` = `{ref ("F1"), tool, operation, label, value, unit, effective_filters, definition,
  access_scope: "visible_to_request_context", source: skh_document_registry | skh_knowledge_graph |
  skh_template_registry | skh_ai_proposals, generation, as_of, items[{id, title, kind: document | template |
  relation | proposal, status, detail, app_path}], truncated, breakdown}`. `[F1]` in `answer` refers to `ref`.
  Render values from here; a fact is computed from the reader's own snapshot.
- `ToolStepInfo` = `{call_id, round, tool, operation, outcome: ok | invalid | unknown_tool | not_found | denied |
  unavailable | timeout | error, duration_ms, result_count, fact_ref, error_code, message}` — no payloads.
- `TurnFactContext` = `{tool, operation, filters (≤ 12 keys, ≤ 1000 chars JSON), document_ids (≤ 20), value}`;
  unknown fields → 422. Context only: IDs the reader can no longer see are dropped, every tool call re-checks access.
- Confidence: an answer backed by `system_facts` may be `supported` without document citations; a general explanation
  is `partial` with `general_knowledge: true` and a warning; without either the v0.4 gate applies unchanged.
- `proposal` may now also come from a `drafts_propose` tool step (same `ProposalRef`, status `suggested`, nothing
  applied); the route requires nothing new — the tool is offered only when the user has `create_proposal`.
- Which answers use tools: a plain question (or `skill_id: "answer"`) with a provider that supports the loop
  (`internal_api`, `claude_cli`) and `AI_TOOLS_ENABLED=true`. `mock`, explicit skills and `AI_TOOLS_ENABLED=false`
  behave exactly as v0.4 (empty `system_facts` / `tool_steps`).
- Client (UI v2, `frontend/src/api/client.ts`): passes `status.round`, `tool_call` and `tool_result` to the caller; a
  malformed tool event is skipped like an unknown event (it only feeds a progress line). A follow-up echoes the
  previous answer's `conversation_context` as `history[i].context`.

## Answer provenance (additive, answer-quality fix)

Every v0.5 field and behaviour is unchanged except one removal: the fixed server warning «Используются только
демо-документы (синтетические данные) — они не являются фактами о банке.» is **no longer added** to answers (it was
added to every answer that had retrieved a demo passage, and to answers without passages whenever some accessible
document was demo — also on non-demo deployments). Provenance is now typed metadata of the VALIDATED evidence
(`app/domain/provenance.py`):

- `AskResponse.provenance: AnswerProvenance` = `{overall: synthetic | not_synthetic | unknown | mixed | none,
  synthetic, not_synthetic, unknown, by_kind: {team?, corporate?, attachment?}}` — distinct sources among the
  validated citations and the document items of the system facts the answer relies on (a skill's chosen document
  counts too). `none`: no source (insufficient evidence, general knowledge, a bare registry count). Never derived
  from retrieved-but-uncited passages or from «any document of the catalog».
- `Citation.provenance: synthetic | not_synthetic | unknown` — from `source_type` + `is_demo`: `synthetic` = marked
  synthetic/demo (front matter `synthetic: true`, a `demo` tag, `LOCAL_CONTENT_IS_DEMO`, the mock Confluence corpus);
  `not_synthetic` = a team document / corporate page without that mark; `unknown` = an attachment (no provenance
  metadata; its `is_demo: false` must not be read as «real»).
- `SystemFactItem.is_demo: bool | null` — for `kind: document` items.
- `catalog_query` (model-visible): `facets` adds `breakdown.provenance {synthetic?, not_synthetic?}` over the whole
  filtered scope (an exhaustive, scoped check the model can cite as `[F1]` when asked «are these real data?»);
  `list` rows carry `synthetic`. Passages handed to a model carry `"synthetic": true|false` in their metadata line
  (not for attachments).
- Warnings that stay (material): `MIXED_PROVENANCE_WARNING` when the evidence mixes synthetic and non-synthetic
  sources; attachment-only evidence; drafts / in_review / deprecated cited; unconfirmed Confluence pages; dropped
  citations or facts; injection-like text; index generations mixed.
- UI contract: show `provenance` as one quiet indicator per answer (e.g. «Источники: синтетические (учебные)»), a
  per-source badge from `Citation.provenance` when the sources differ (`mixed`; otherwise the indicator covers
  them), and nothing when `overall` is `none`. The mode label (`mode: mock` — «без языковой модели») is a separate
  concept from synthetic content. Implemented in `docs/UI_REDESIGN.md` «Происхождение источников и режим ИИ».

## Implemented contract (v0.6, Template Studio)

Additive only: every earlier route, field and behaviour is unchanged, except that the Template Hub routes
(`GET /api/templates*`) now declare the new `view_templates` right instead of `read_knowledge` (the local demo
operator has both). Design and rules: `docs/TEMPLATE_HUB.md` «Template Studio»; AI proposals:
`docs/AI_WORKFLOWS.md` «Template proposals».

| Route | Action | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/templates/studio/options` | `view_templates` | — | `StudioOptions {doc_types, metadata_fields, statuses, reserved_ids, prefixes {PREFIX: template_id}, template_id_pattern, id_prefix_pattern, max_sections, permissions {view, create, edit, activate}, ai {available, mode, reason}, defaults: TemplateSpec}` | — |
| `POST /api/templates/studio/validate` | `view_templates` | `{spec: TemplateSpec, template_id?}` (`template_id` = the template being edited; absent = a new one) | `StudioCheck` (below); nothing stored | `422 validation_failed` (bounds) |
| `POST /api/templates/studio` | `create_template` | `{spec, ai_proposal_id? ("AIP-…")}` | `201 StudioSaveResult {state, check}`: the template exists as a DRAFT only (status `draft` in the catalogue, not offered to documents or the AI). With `ai_proposal_id` this is the Accept of a `draft_template` proposal: it becomes `applied`, `result_template_id` set | `422 template_invalid` (`details.issues` — ID invalid / taken / reserved), `409 template_id_taken` (race), `409 ai_proposal_closed`, `404 ai_proposal_not_found` |
| `GET /api/templates/{id}/studio` | `view_templates` | — | `StudioState` (below) | `404 template_not_found` |
| `PUT /api/templates/{id}/studio/draft` | `edit_template` | `{spec, expected_revision}` | `200 StudioSaveResult`. The current version stays current. A draft may keep errors (returned in `check.issues`); only activation needs a clean check. The first write to a shipped template adopts it (`kind: adopted`, `expected_revision: 0`) | `409 template_conflict` (`details.current_revision`), `422 template_invalid` (`template_id_changed`), `404` |
| `DELETE /api/templates/{id}/studio/draft?expected_revision=` | `edit_template` | — | `200 StudioState` without the draft; `204` when a never-activated template disappears with it | `409 template_conflict`, `409 template_draft_missing` |
| `POST /api/templates/{id}/studio/activate` | `activate_template` | `{expected_revision, version?}` | `StudioActivation {action: activated \| info_updated \| reactivated, version, state}`. Without `version`: the open draft — a new schema is the next free version; the same schema corrects the catalogue text of the current version in place (no new version); the schema of an older version makes that version current again. With `version`: an existing version becomes current (a rollback, or a version a release shipped). Documents and drafts keep their pinned version | `409 template_conflict`, `409 template_draft_missing`, `409 template_version_active`, `422 template_invalid` (`details.issues`), `404 template_version_not_found` |
| `POST /api/templates/{id}/studio/acknowledge-shipped` | `edit_template` | `{expected_revision}` | `StudioState`: the studio version stays current; `shipped_update` is cleared (the shipped version stays readable) | `409 template_conflict`, `409 template_no_shipped_update` |
| `GET /api/templates/{id}/studio/compare?from=N&to=M\|draft` | `view_templates` | — | `TemplateComparison` (below) | `404 template_version_not_found\|template_draft_missing` |
| `POST /api/ai/proposals` | `create_proposal` **and** `create_template` for `kind: draft_template` | `{kind: "draft_template", prompt (10–2000)}` | `201 AiProposal`: items `template` (the proposed `TemplateSpec`, applicable) and `similar` (note: existing templates with a score and a reason); `warnings` name similar templates and every value the server replaced | `403 forbidden`, `503 ai_template_unavailable` (mock: no language model; disabled), `502 ai_invalid_response`, `422` |
| `POST /api/ai/proposals/{id}/accept` | `create_proposal` | — | unchanged for other kinds | `409 ai_proposal_use_editor` for `draft_template` (accepted only by saving it in the editor) |

- `TemplateSpec` = `{template_id, title, description, category, doc_type, id_prefix, owner, labels[], default_tags[],
  sections[{title, required, hint, content}], required_metadata[], optional_metadata[], validation[], instructions,
  ai_guidance, example, changes, breaking, migration, status: active|deprecated|archived}`; bounded by size (`422`).
- `StudioIssue` = `{field, code, message, severity: error|warning}`; `field` names a spec field or an item:
  `title`, `id_prefix`, `sections`, `sections.2.title`, `sections.0.content`, `validation.1`, `required_metadata`,
  `migration`, `source` (the file parser). Codes: `template_id_invalid|reserved|taken|changed`, `title_missing`,
  `doc_type_invalid`, `id_prefix_invalid|reserved|taken`, `tag_invalid`, `sections_missing`,
  `required_section_missing`, `section_title_missing|invalid|too_long|duplicate`, `section_content_heading`,
  `metadata_unknown|title_required|both`, `rule_empty|too_long|duplicate`, `migration_missing`, `header_too_large`,
  `template_too_large`, `template_invalid`; warnings: `description_missing`, `category_missing`, `owner_missing`.
- `StudioCheck` = `{valid, issues[], activation: new_template|new_version|info_update|reactivate|no_change,
  next_version, schema_changed, changed_fields[], source (the template file), preview {document_id (a sample),
  markdown (the new document's file), html (sanitized), sections[{title, required, hint}]}}`.
- `StudioState` = `{template_id, kind: shipped|created|adopted, revision, current_version|null, current: TemplateSpec|null,
  draft: {spec, base_version, saved_by, saved_at, check}|null, versions[{version, status, current, source:
  shipped|studio, first_seen, changes, breaking, activated_by, activated_at, documents}], events[{at, actor, action,
  version, revision, summary}], shipped_version, shipped_update, updated_by, updated_at, ai_proposal_id}`.
- `TemplateComparison` gains `fields_changed[]` (spec field names), `source_diff: DiffResult` (the template source)
  and `to_draft`; also on `GET /api/templates/{id}/compare`.
- `TemplateSummary` / `TemplateDetail` gain `source: shipped|studio`, `has_draft`, `shipped_update`. A template that
  was never activated is listed with `status: "draft"` and `versions: []`; `GET /api/templates/{id}` returns its
  draft (status `draft`, no history); `/versions/{v}` is `404` for it.
- `AiProposal.kind` gains `draft_template`; `AiProposal.result_template_id`.

## Implemented contract (v0.7, M6 Work Management — steps 1–5)

Additive only. Design, semantics and the identity gate: `docs/WORK_MANAGEMENT.md`. Every route declares one action
on the global policy; the work gate then applies `local_operator` / `read_only` / `membership` (§4 there). `{project_id}`
accepts the id or the key (`ARIS`); `{task_id}` the id or the key (`ARIS-12`). Request bodies are strict (unknown or
server-owned fields → `422 invalid_request`). Dates are `YYYY-MM-DD`; a scheduled task is `[start_date, end_exclusive)`.

| Route | Action | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/work/capabilities` | `view_projects` | — | `WorkCapabilities {enabled, mode, label, can_write, can_view_audit, read_only_reason, team_ready (false), identity, calendar, statuses, priorities, project_statuses, schedule_modes, link_relations, limits, features}` | `503 feature_unavailable` |
| `GET /api/work/assignees?project_id=` | `view_projects` | — | `AssigneeRef[] {id, display_name, kind: operator\|fixture\|member\|unknown}` | `404` |
| `GET /api/projects?status=&include_archived=` | `view_projects` | — | `{items: ProjectOut[], total}`; only member projects in `membership` | `400 invalid_filter` |
| `POST /api/projects` | `manage_project` | `{key, title, description?, status?, timezone?, start_date?, target_date?, client_request_id?}` | `201 ProjectOut` (replay of `client_request_id` → the first result) | `409 conflict` (`key_taken`, `idempotency_key_reused`), `422 invalid_request\|invalid_date_range`, `403` |
| `GET /api/projects/{project_id}` | `view_projects` | — | `ProjectOut {…, version, plan_revision, is_demo, stats {total, by_status, open, blocked, overdue, milestones, unscheduled, next_milestone}, my_role}` | `404` (also not a member) |
| `PATCH /api/projects/{project_id}` | `manage_project` | `{expected_version, title?, description?, status?, timezone?, start_date?, target_date?}` | `ProjectOut` | `409 stale_project` (`details.current_version`), `422`, `403` |
| `GET /api/projects/{project_id}/members` | `view_projects` | — | `{project_id, mode, members[], note}` — empty in `local_operator` (no team roles are claimed) | `404` |
| `GET /api/projects/{project_id}/activity?limit=&before_seq=` | `view_work_audit` | — | `{items: ActivityEvent[], next_before_seq}` | `403` (read-only/viewer), `404` |
| `GET /api/projects/{project_id}/tasks` | `view_tasks` | query: `status`, `priority` (comma lists), `assignee` (id\|`none`), `parent` (id\|`root`), `q` (title/key, case-insensitive), `milestone`, `scheduled`, `overdue`, `blocked`, `include_archived`, `sort` (`key\|title\|status\|priority\|start_date\|due_date\|updated_at\|sort_order`), `order`, `limit` ≤ 500, `offset` | `{project_id, plan_revision, items: TaskOut[], total, limit, offset, today}` | `400 invalid_filter`, `404` |
| `POST /api/projects/{project_id}/tasks` | `create_task` | `TaskCreate {title, description?, parent_task_id?, status?, priority?, assignee_id?, estimate_workdays?, start_date?, end_exclusive? \| duration_workdays?, due_date?, is_milestone?, date_locked?, sort_order?, expected_plan_revision?, client_request_id?}` | `201 TaskOut` | `422 invalid_date_range` (`partial`, `end_before_start`, `no_workdays`, `duration_zero`, `duration_mismatch`, `milestone_point`, `milestone_duration`, `lock_requires_dates`, `out_of_range`), `422 invalid_hierarchy` (`too_deep`, `milestone_parent`, `parent_not_in_project`, `parent_archived`), `422 invalid_assignee`, `409 stale_schedule`, `409 conflict` (`project_archived`, `task_limit`, `idempotency_key_reused`) |
| `GET /api/tasks/{task_id}` | `view_tasks` | — | `TaskOut` (also archived) | `404` |
| `PATCH /api/tasks/{task_id}` | `edit_task` | `TaskUpdate {expected_version, …any TaskCreate field}`; `null` clears; `start_date` alone moves keeping the duration; `start_date=null, end_exclusive=null` unschedules | `TaskOut` (no change → same version) | `409 stale_task` (`details.current_version`), `409 conflict` (`task_archived`, `milestone_has_children`), `422 invalid_hierarchy` (`parent_cycle`, `self_parent`, `dependency_with_ancestor`…), `422 schedule_conflict` (`fs_violation` with `violations[]`, `task_locked`), `422 invalid_date_range` |
| `DELETE /api/tasks/{task_id}?expected_version=&cascade=` | `edit_task` | — | `{archived: TaskOut[], removed_dependency_ids, plan_revision}` (soft delete) | `409 conflict` (`has_children` + `children`), `409 stale_task` |
| `POST /api/tasks/{task_id}/restore?expected_version=` | `edit_task` | — | `TaskOut` (+ the subtree archived by the same operation) | `409 conflict` (`parent_archived`, `task_active`) |
| `GET /api/tasks/{task_id}/activity` | `view_work_audit` | — | `ActivityPage` (also dependency events where the task is the predecessor) | `403`, `404` |
| `GET /api/tasks/{task_id}/dependencies` | `view_tasks` | — | `{task_id, plan_revision, predecessors[], successors[]}` each `{dependency: DependencyOut {…, satisfied}, task: TaskBrief}` | `404` |
| `POST /api/tasks/{task_id}/dependencies` | `schedule_task` | `{predecessor_task_id \| successor_task_id, kind: "FS", lag_workdays: 0, expected_plan_revision?}` | `201 {dependency, plan_revision}` | `422 invalid_dependency` (`self`, `not_in_project` — also for unknown ids, `archived`, `duplicate`, `hierarchy`), `422 dependency_cycle` (`cycle`, `cycle_keys`), `422 schedule_conflict` (`dependency_violated`, `earliest_start`), `409 stale_schedule` |
| `DELETE /api/tasks/{task_id}/dependencies/{dependency_id}?expected_plan_revision=` | `schedule_task` | — | `{dependency_id, plan_revision}` | `404`, `409 stale_schedule` |
| `GET /api/projects/{project_id}/gantt` | `view_tasks` | — | `{project_id, project_key, plan_revision, snapshot_at, today, calendar, tasks (tree order), dependencies, unscheduled_task_ids, violations[], range_start, range_end_exclusive, critical_path: null, features}` — one snapshot | `404` |
| `POST /api/projects/{project_id}/schedule/preview` | `schedule_task` | `{mode: only_this_task\|shift_successors\|resolve_violations, changes: [{task_id, start_date, end_exclusive \| duration_workdays}] ≤ 100, add_dependencies: [{predecessor_task_id, successor_task_id}] ≤ 20, base_plan_revision?}` | `SchedulePreview {preview_id, base_plan_revision, input_hash, operations[{task_id, key, change, before, after, shift_workdays, reason, because_of, version}], added_dependencies, conflicts[], warnings[], blocked_tasks[], unchanged[], can_apply, critical_path: null, created_at, expires_at}`; writes no task/revision/audit | `404` (unknown task), `422` (validation, `dependency_cycle`, `invalid_dependency`, `invalid_date_range`), `409 stale_schedule`, `403` |
| `POST /api/projects/{project_id}/schedule/apply` | `schedule_task` | `{preview_id, expected_plan_revision, client_request_id, accept_warnings?}` | `ScheduleApplyResult {preview_id, applied, plan_revision, changed_tasks, added_dependencies, correlation_id, replayed}` | `409 stale_schedule` (`plan_revision`, `snapshot_changed`, `expired`, `already_applied`, `task_changed`, `revalidation_failed`), `422 schedule_conflict` (`conflicts`, `warnings_not_accepted`), `409 conflict` (`idempotency_key_reused`), `404` (unknown or someone else's preview) |
| `GET /api/tasks/{task_id}/links` | `view_tasks` | — | `TaskLinks {task_id, task_key, knowledge_available, generation, items: TaskLinkOut[]}`; `TaskLinkOut {id, task_id, relation, source_system: "skh", state: current\|revision_changed\|revision_unknown\|unavailable\|unverified, document: {document_id, title, type, status, version, revision, is_demo, app_path} \| null, revision_at_link, deprecated, approved, created_by, created_at}` — `document`/`revision_at_link` are `null` unless the reader can see the document NOW | `404` |
| `POST /api/tasks/{task_id}/links` | `edit_task` | `{document_id, relation?: implements\|requires\|documents\|verifies\|blocks, client_request_id?}` (the server records the canonical id and the revision it sees) | `201 TaskLinkOut` | `404 not_found` (document missing or not visible — the same answer), `409 conflict` (`link_exists`, `task_archived`, `project_archived`, `idempotency_key_reused`), `503 knowledge_unavailable`, `403` |
| `DELETE /api/tasks/{task_id}/links/{link_id}` | `edit_task` | — | `{link_id, task_id}` (status `removed`, the row stays as history) | `404`, `409 conflict` (`task_archived`) |
| `POST /api/tasks/{task_id}/links/{link_id}/acknowledge` | `edit_task` | — | `TaskLinkOut` with the current revision recorded (explicit only; no-op when equal) | `404` (link, or document not visible), `503 knowledge_unavailable` |
| `GET /api/projects/{project_id}/documents` | `view_tasks` | — | `{project_id, knowledge_available, items: [{document, task_count, changed_count}]}` — visible documents only | `404` |
| `GET /api/documents/{document_id}/tasks` | `view_tasks` (+ `read_knowledge`) | — | `{document_id, revision, items: [{link_id, relation, state, revision_at_link, task_id, task_key, title, status, project_id, project_key, project_title, app_path}], total}` — active tasks of projects the reader may view | `404 document_not_found` (not visible), `503 knowledge_unavailable\|feature_unavailable` |
| `POST /api/work-ai/proposals` | `propose_work` | `WorkPlanCreate {project_id, request (3–2000), document_ids ≤ 5, start_date?, parent_task_id?}` | `201 WorkProposalOut {id (WAP-…), project_id, project_key, kind: task_plan, schema_version, status: suggested\|applied\|rejected, state: ready\|stale\|applied\|rejected, stale_reasons[], provider, request, goal, start_date, parent_task_id, parent_task_key, base_plan_revision, current_plan_revision, created_at, expires_at, decided_at, tasks: ProposedTask[], dependencies[{predecessor, successor, kind: FS}], sources: ProposalSourceRef[], assumptions[], issues[{code, message, local_id, severity}], can_apply, applied_task_keys[]}`; writes NO task | `403` (read-only — before any model call), `404` (project / document not visible), `422 proposal_invalid` (`dependency_cycle`, `unknown_task_in_dependency`, `self_dependency`, `hierarchy_dependency`, `unknown_parent`, `parent_cycle`, `milestone_parent`, `too_deep`, `duplicate_local_id`, `no_sources`; nothing stored), `503 feature_unavailable` (no planning-capable provider), `502/503 ai_*`, `503 knowledge_unavailable` |
| `GET /api/work-ai/proposals/{proposal_id}` | `propose_work` | — | `WorkProposalOut` (state re-computed: `stale` when the plan revision, a source revision or its visibility changed, or it expired) | `404` (someone else's: proposals are personal) |
| `POST /api/work-ai/proposals/{proposal_id}/preview` | `propose_work` | `WorkProposalEdits {tasks: [{local_id, include?, title?, description?, priority?, estimate_workdays?, assignee_id?}], excluded_dependencies: [{predecessor, successor}], start_date?}` | `WorkProposalOut` with the edits and server-computed dates; writes nothing | `422 proposal_invalid` (`unknown_local_id`, `unknown_dependency`, `milestone_estimate`), `422 invalid_request` |
| `POST /api/work-ai/proposals/{proposal_id}/apply` | `apply_work_proposal` | `WorkProposalEdits + {expected_plan_revision, client_request_id}` | `WorkProposalApplyResult {proposal_id, project_id, applied, plan_revision, created_tasks: TaskOut[], created_dependencies, created_links, replayed}` — one transaction | `409 proposal_stale` (`plan_changed`, `source_changed`, `source_unavailable`, `expired`, `already_applied`, `already_rejected`), `422 proposal_invalid` (`nothing_to_apply` …), `422 invalid_assignee`, `422 invalid_hierarchy`, `503 knowledge_unavailable`, `403` |
| `POST /api/work-ai/proposals/{proposal_id}/reject` | `propose_work` | — | `WorkProposalOut` (`rejected`; no task) | `409 proposal_stale` (`already_*`) |

- `TaskOut` = `{id, project_id, key, number, parent_task_id, depth, title, description, status, priority, assignee_id,
  assignee, reporter_id, estimate_workdays, start_date, end_exclusive, last_day, duration_workdays, due_date,
  is_milestone, date_locked, scheduled, sort_order, is_demo, version, created_by, created_at, updated_by, updated_at,
  archived_at, blocked_by[], is_blocked, overdue, late, child_count, link_count, document_ids}` — `link_count` /
  `document_ids` count only documents the reader can see now (`null` when the knowledge source cannot be read).
  `GET …/tasks?document=ID` filters by a linked document (a hidden id matches nothing; `503 knowledge_unavailable`
  when the source cannot be read).
- `WorkCapabilities.features.document_links = true`; `features.ai_proposals` = the configured AI provider can plan
  (`internal_api`, `claude_cli`), `false` with `mock` / `disabled`.
- M5.7 tool `work_inspect` (`docs/AI_NATIVE_TOOLS.md`): system facts with `source: "skh_work"` and items of kind
  `task` / `project` (`app_path` `/tasks/KEY`, `/projects/KEY`).
- Read-only exposure: every write, preview/apply and activity route answers `403 forbidden` with `details.mode =
  "read_only"` and `details.reason`; reads keep working. Membership mode: a non-member gets `404` for the project and
  everything in it (no titles, counts or existence leaks).
- Additive elsewhere: `SessionResponse.features.work_management` (`local_operator\|read_only\|membership\|disabled`);
  `GET /api/integrations/status` item `task_system` is the built-in module (`connected`, target `local`, access
  `read_write`/`read`); CORS allows `PATCH`.
