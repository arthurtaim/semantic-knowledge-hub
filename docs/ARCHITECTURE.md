# Architecture and technology decisions

## 1. Topology (as implemented, M4.6 + M4 readiness + M5)

```text
Browser (React/Vite, CSP, no external resources)
   │
FastAPI backend — every route: require(Action) → AuthorizationPolicy (LocalDemoPolicy | DenyAllPolicy)
   │
   ├─ KnowledgeService ──── KnowledgeRepository: LocalKnowledgeRepository | GitLabKnowledgeRepository
   │   (sync, sort,           (GitLab REST v4: head probe, keyset tree, commit-SHA revisions,
   │    staleness)             merge evidence per commit)
   ├─ SearchService ─────── SQLite FTS5 index (doc_versions: source + revision)
   │                        CorporateKnowledgeConnector: Disabled | Mock | ConfluenceMCPConnector (READ-ONLY,
   │                          Streamable HTTP, service-account token — single-user only)
   ├─ AssistantService ──── AIProvider.answer (mock | internal_api | disabled) + citation validation
   ├─ AuthoringService ──── templates (files) · generated frontmatter · ID/path checks · safe preview
   │                        AIProvider.draft_document + verbatim citation check (scope "team")
   ├─ ProposalService ───── ProposalStore (SQLite: proposals, content-free audit)
   │   (create|update,        ProposalPublisher: Disabled | GitLabMRPublisher
   │    editable drafts,        (kb/update/* branch → one update|create commit → Draft MR; MR state read back)
   │    lifecycle, conflicts)
   └─ PublicationService ── PublicationStore (SQLite: jobs, mappings, events)
       (jobs, read-only       render_storage (Markdown → Confluence DC storage format)
        dry-run, explicit     ConfluencePublisher: Disabled | ConfluenceRESTPublisher
        publish, reconcile)     (ConfluenceDCClient → /rest/api; one space + parent; dedicated token)

Post-merge hook: ProposalService (GitLab reports `merged`) → knowledge sync + FTS → merged_revision →
PublicationService.on_document_merged (job + dry-run; never publishes by itself).

GitLab = source of truth (Markdown + YAML, branches, MRs, human review). Confluence DC: read through MCP,
write only through the REST publisher after a confirmed merge. GitHub holds application code only.
TEST DOUBLES (backend/tests/support, never in the app image): gitlab_mock.py (GitLab REST v4 subset),
mcp_mock.py (MCP server), confluence_mock.py (Confluence DC REST subset), mock_scenario.py (Docker scenario).
```

Run modes (`INTEGRATION_PROFILE`, enforced at startup by `security_violations`; details in
`docs/M4_M5_INTEGRATION_READINESS.md` §0):

| Profile | Targets | Writes |
|---|---|---|
| `offline` (default) | none — local workspace, mock AI, built-in synthetic corporate pages | proposals stay local |
| `integration_mock` | only declared test doubles (loopback or `MOCK_SERVICE_HOSTS`: `*.example`, `*.test`, `*.invalid`, `*.localhost`, `<name>-mock`) | GitLab MR and Confluence pages — to the doubles only |
| `live_read_only` | real test systems, `https` only (prepared, not run) | none; Confluence publication is dry-run only |
| `live_write_staging` | separate test project / `[TEST]` space, `https` only (prepared, not run) | GitLab MR; Confluence only with `CONFLUENCE_PUBLISH_STAGING_ACK` = target space and a corporate CA |

Docker: `docker-compose.yml` (offline; backend on an `internal` network), `docker-compose.mock.yml`
(`integration_mock`: three doubles on the internal network, no host ports, separate project `skh-mock`, UI on
`127.0.0.1:5174`), `docker-compose.integration.yml` (egress + secrets directory for the test environment).

## 2. Stack for local MVP
- Python 3.12+ and FastAPI with Pydantic v2; pytest, httpx, ruff.
- React, TypeScript, Vite; UI styling simple and coherent; Vitest for component tests.
- Search: SQLite FTS5 index of local test documents (or well-tested deterministic fallback if FTS5 unavailable). Rebuildable from source Markdown. Store no canonical knowledge in search index.
- Local draft/audit state: SQLite or a simple atomic file store under ignored workspace. Database stores derived app state only, not authoritative knowledge.
- `docker compose` runs UI and API bound to localhost by default. A documented non-Docker developer workflow is required.
- No LangGraph, specialized vector DB or message broker in MVP.

## 3. Clean component boundaries
Implement separate protocols/interfaces:
- `KnowledgeRepository`: list/get/search-index input/read version, optional propose-change. Implement `LocalKnowledgeRepository` now; `GitLabKnowledgeRepository` later.
- `SearchService`: lexical search over accessible documents; optional corporate search connector; deduplicated source-aware results.
- `AIProvider`: `generate_answer(question, grounded_context, options)`; `MockAIProvider` returns deterministic supported snippets, `OpenAICompatibleAIProvider` uses explicitly configured internal endpoint. Future `GigaCodeAdapter` only if documented accessible integration exists.
- `CorporateKnowledgeConnector`: `search(query,user_context)`, `get_page(page_id,user_context)`; `DisabledConnector`/`MockConnector` and eventual `ConfluenceMCPConnector`.
- `ProposalStore`: create/get/list/reject/mark_ready diff proposals with version preconditions; editable drafts (`save_draft` with `expected_version`, `delete_draft`); do not write approved source silently.
- `ProposalPublisher`: `DisabledProposalPublisher` (offline) or `GitLabMRPublisher` (branch + one `update`/`create` commit + Draft MR).
- `AuthoringService`: templates (files, `app/document_templates/` or `DOCUMENT_TEMPLATES_DIR`), generated frontmatter, validation incl. ID/path uniqueness, safe preview, AI-assisted drafts with server-side citation verification. Never writes the knowledge base.
- `ConfluencePublisher`: `DisabledConfluencePublisher` (no `CONFLUENCE_REST_URL`) or `ConfluenceRESTPublisher` (reads always; writes only when `write_enabled`); no calls in the offline demo.
- `PublicationService` + `PublicationStore`: durable jobs, document→page mappings, content-free events; dry-run with read requests only; explicit publish.

## 4. Source semantics and precedence
- Approved GitLab documents: authoritative for team product definitions.
- Authorized Confluence pages: authoritative for corporate requirements within their scope.
- A conflict between two sources must be shown, not silently decided by the LLM.
- Draft/Deprecated documents are shown with visible status and excluded from default authoritative evidence unless user explicitly includes them.
- Synthetic fixtures are for demo only, visibly marked `DEMO`; never cited as actual bank facts.

## 5. Data flow: question
1. Authenticate/identify viewer (localhost demo identity in MVP only).
2. Check allowed repositories/spaces; select document filters.
3. Retrieve top-ranked accessible documents with exact metadata and references.
4. Bound input size; preserve stable citation IDs and source locations.
5. If AI enabled, call configured `AIProvider` with untrusted source content clearly delimited and prompt-injection protections. If mock, return deterministic evidence snippets.
6. Validate citations refer to retrieved accessible documents. If insufficient context, disclose it.
7. Show answer, references, source types and reliability state. Avoid storing sensitive question/answer bodies in logs.

## 6. Data flow: proposed change
1. Viewer requests change to a known document at revision `base_commit_sha` or equivalent.
2. Compute a proposed new Markdown file without updating approved content.
3. Validate schema, sanitize preview, compute diff and store proposal locally.
4. User reviews and rejects or marks ready; future GitLab adapter opens branch and MR in GitLab.
5. Merge decisions happen through GitLab reviewer rules and protected branches.
6. After GitLab confirms the merge, the knowledge base is re-synced and the merged revision recorded; a publication job with a read-only dry-run is prepared when publication is configured. Publishing is a separate explicit action; never direct write to GitHub application repo.

## 7. Deployability
Local: `docker compose` or documented `uvicorn` and Vite commands, localhost bindings, synthetic fixtures. Future on-prem: reverse proxy, corporate SSO and RBAC, allowlisted network, secret manager, persistent volume for derived state, GitLab/Confluence credentials, monitoring. The app must reject insecure production configuration, especially `AUTH_MODE=local_demo` with public binding.

## 8. Correctness constraints
- Stable document IDs are separate from filenames and Confluence page IDs.
- All adapters return consistent document metadata and `source_uri`.
- Preserve commit SHA/content revision in proposals; reject conflicts.
- No hidden automatic publishing, migrations, backups or Git push without explicit user operation.
- The network is disabled by default; mocks are named mocks; external integrations are feature gated.

## 9. M4.5 implementation notes
- **Knowledge provider contract** (`adapters/knowledge/base.py`): list (`snapshot`), get, get at revision,
  exists, fresh `current_revision` for conflict checks, manual `refresh(full)`, `sync_info`. Business logic
  depends on the protocol only; no service imports the GitLab HTTP client.
- **Synchronisation:** described in `docs/GITLAB_KNOWLEDGE_WORKFLOW.md` §8. The search index is derived
  state and keeps one row per document with source and revision. Stale data is flagged per document
  (`index_state`) and globally (`/api/index/status`), never shown as current.
- **Lifecycle:** `docs/GITLAB_KNOWLEDGE_WORKFLOW.md` §4–7. Writes are never retried blindly. Uncertain
  outcomes are stored and resolved by reading GitLab state.
- **Authorization seam:** `app/authz.py` (ADR-024). Only the loopback single-operator policy exists.
  Requirements for SSO and RBAC are in `docs/SSO_RBAC_REQUIREMENTS.md`.
- **Network modes:**
  - *Offline* (default): local workspace, mock AI, no integrations; the backend container sits on an
    `internal` network with no route out.
  - *Integration mock* (`docker-compose.mock.yml`): stateful test doubles on the same internal network.
  - *Integration* (`docker-compose.integration.yml`): egress network, secrets from an external directory,
    corporate CA, allowlisted hosts only; passes `INTEGRATION_PROFILE` (default `live_read_only`) and the
    `CONFLUENCE_REST_*` / `CONFLUENCE_TARGET_SPACE` / `CONFLUENCE_PARENT_PAGE_ID` / `CONFLUENCE_PUBLISH_*` variables.

  The application allowlist does **not** replace infrastructure firewall rules (PB-06).

## 10. M4.6 authoring and M5 publication notes
- **Three independent state machines:** document status (front matter, changed only by a GitLab merge),
  proposal status (`docs/GITLAB_KNOWLEDGE_WORKFLOW.md` §5) and publication job state
  (`docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md` §3). They are never merged into one status.
- **New documents** are `create` proposals: same review → branch → MR → merge path; `create` commit action
  without `last_commit_id`; the file must not exist (checked against a fresh read and enforced by GitLab).
  Workflow: `docs/DOCUMENT_CREATION_WORKFLOW.md`; templates: `docs/DOCUMENT_TEMPLATES.md`.
- **AI authoring** (`AIProvider.draft_document`) receives only approved team documents (scope `team`);
  citations are re-verified verbatim by `AuthoringService`; the result is a suggestion that is never stored
  or approved by itself (`docs/AI_AUTHORING_CONTRACT.md`).
- **Publication** uses the Confluence Data Center REST API (not MCP, not Cloud v2) with a dedicated token;
  space and parent come from configuration only; ownership = durable mapping + content property
  `skh-managed-document` (`docs/CONFLUENCE_MAPPING.md`). Merge evidence comes from GitLab
  (`GET /projects/:id/repository/commits/:sha/merge_requests`). Execution is synchronous with durable state
  (SQLite); one active job per document; no queue system.
- **Integration status labels:** `target` (`none|local|mock|real`), `access` (`none|read|write|read_write`),
  `checked_at` on every item of `GET /api/integrations/status`; `real` never implies live validation.
- **Readiness probe:** `python -m app.readiness` (read-only requests through the app's own adapters) next to
  the offline `python -m app.preflight`.
