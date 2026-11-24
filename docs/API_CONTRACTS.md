# API contracts and interface shapes

These are proposed MVP HTTP contracts. Claude Code may refine field details but must document changes, keep tests consistent and preserve adapter boundaries. All routes prefixed `/api`.

**Current implemented contract: v0.4 (v0.3 + UI v2 phase C: assistant skills and attachments)** — see the last two sections. Earlier sections describe the original proposal and the v0.1/v0.2 refinements, which remain valid unless v0.3 says otherwise. The served schema is `GET /api/openapi.json`.

## 1. Health and integrations
- `GET /api/health` -> `{ "status": "ok", "mode": "local_demo" }` (no secrets).
- `GET /api/integrations/status` -> provider status list with `name`, `state` (`connected|disabled|mock|error`), `capabilities`, `human_readable_message`. Never report `connected` solely because an environment variable is set; probe if enabled.

## 2. Knowledge
- `GET /api/documents?query=&type=&status=&owner=&source=&page=1&size=20` -> `{items:[DocumentSummary],total,page,size}`.
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
  "warnings": ["Используются только демо-документы"]
}
```

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
- **Sorting.** `GET /api/documents?sort=relevance|title|updated|status` (`updated` = newest first, undated last); unknown values → `422`.
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
| `create_proposal` | + `POST /api/authoring/check`, `POST /api/authoring/ai-draft`, `POST /api/authoring/drafts`, `PUT /api/drafts/{id}`, `DELETE /api/drafts/{id}` |
| `read_knowledge` | + `GET /api/authoring/templates`, `GET /api/documents/{id}/publication`, `GET /api/publications/jobs*` |
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
```

**Skills and AI modes.** `internal_api`, `claude_cli`: all available. `mock`: all except `improve_section`
(`unavailable_reason`: «В демо-режиме нет языковой модели: переписать раздел нельзя.» — the mock can only normalize
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
