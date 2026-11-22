# API contracts and interface shapes

These are proposed MVP HTTP contracts. Claude Code may refine field details but must document changes, keep tests consistent and preserve adapter boundaries. All routes prefixed `/api`.

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
- Later: `POST /api/drafts/{draft_id}/open-mr` -> privileged GitLab branch+MR creation, only with user permission and explicit feature flag.

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
- Drafts: statuses are `open → ready_for_review | rejected`, `ready_for_review → rejected | submitted`. `submitted` means a GitLab MR exists (set by `open-mr`); from then on rejecting or merging happens only in GitLab, and a closed MR is never re-created. `POST /api/drafts` also accepts `origin` (`manual|ai_suggestion`) and returns `201` with the full detail (diff in `unified` text and structured `lines`, `validation`, `history`, `is_stale`, `can_mark_ready`, `can_reject`, `publication`). A draft with validation errors is stored but `mark-ready` → `422 validation_failed`. `GET /api/drafts?status=&document_id=` lists drafts. `POST /api/drafts/suggest` asks the AI provider for a proposed text (not stored; `503 ai_edit_unsupported` in mock mode). `POST /api/drafts/{id}/open-mr` → `503 gitlab_proposals_disabled` unless enabled; `409` when not ready or when the source revision changed.
- `GET /api/corporate/pages/{page_id}` reads one page through the corporate connector (`503` when disabled, `404` for unknown or unauthorized pages — indistinguishable on purpose).
- Every state-changing request must carry `X-SKH-Client` (`403 csrf_header_missing`); requests with a non-allowlisted `Host` → `400 host_not_allowed`.
