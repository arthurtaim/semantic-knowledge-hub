# Architecture and technology decisions

## 1. Topology (as implemented, M4.5)

```text
                 Browser (React/Vite, CSP, no external resources)
                                 |
              FastAPI backend — every route: require(Action) → AuthorizationPolicy
        /               |                    |                     \
 KnowledgeService   SearchService     AssistantService        ProposalService ── ProposalStore (SQLite: proposals,
  (sync, sort,      (team + corporate   (retrieval, citation     (lifecycle, validation,         content-free audit)
   staleness)        scopes, provenance)  validation, injection    conflict checks)
        |                 |                 guards)                     |
 KnowledgeRepository   SQLite FTS5 index      |                   ProposalPublisher
  /            \        (incremental,       AIProvider            /            \
Local          GitLab    doc_versions:      mock | internal_api   Disabled     GitLabMRPublisher
workspace      (REST v4: source+revision)   | disabled            (offline)    (kb/update/* branch → commit
(content-hash  head probe, keyset tree,                                          with last_commit_id → Draft MR;
 revisions)    blob-incremental reads,      CorporateKnowledgeConnector         MR state read back)
               commit SHA revisions)        Disabled | Mock | Confluence MCP (Streamable HTTP, read-only,
                                                               service-account token — single-user only)

GitLab = source of truth (Markdown + YAML, branches, MRs, human review). Confluence publication (M5) is not
implemented and refuses to start. GitHub holds application code only.
Tests: GitLab TEST DOUBLE (backend/tests/support/gitlab_mock.py), MCP replay scenarios — never shipped.
```

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
- `ProposalStore`: create/get/list/reject/mark_ready diff proposals with version preconditions; do not write approved source silently.
- `ProposalPublisher`: no-op/local mock now; `GitLabMRPublisher` later.
- `ConfluencePublisher`: opt-in only, no calls in offline demo.

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
6. Approved change is eligible for optional Confluence publication; never direct write to GitHub application repo.

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
  - *Integration* (`docker-compose.integration.yml`): egress network, secrets from an external directory,
    corporate CA, allowlisted hosts only.

  The application allowlist does **not** replace infrastructure firewall rules (PB-06).
