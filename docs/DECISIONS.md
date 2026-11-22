# Architecture decision log

| ID | Decision | Why | Revisit when |
|---|---|---|---|
| ADR-001 | GitHub for app code only | Separate app lifecycle from bank knowledge | Corporate requirements change |
| ADR-002 | GitLab canonical knowledge store | Git history, review, ownership, future team workflow | Need for richer collaborative authoring arises |
| ADR-003 | Confluence DC read through approved MCP | Access to broader enterprise knowledge and existing ACL | Bank provides another supported interface |
| ADR-004 | One-way approved GitLab -> Confluence publish, later | Avoid conflicting source-of-truth state | Publication requirements clarified |
| ADR-005 | Offline mocks in MVP | No bank credentials required and safe for public code tooling | Company authorizes connections |
| ADR-006 | Existing Claude Code as developer, GigaCode later as runtime/agent | Keep model/agent portability | Confirm exact installed GigaCode interface |
| ADR-007 | FastAPI + React + SQLite FTS5 | Lightweight MVP and clear API separation | Scale/search evaluation indicates otherwise |
| ADR-008 | No direct automatic approval/publication by AI | Banking governance | Approved workflow changes |

## Pending decisions for team/infrastructure
- GitLab self-managed URL, project ID, branch policy, token/identity method.
- Confluence DC version, MCP implementation, allowed spaces, user context propagation.
- Internal AI API schema/model/context limits and data-handling policy.
- Approved server deployment model, SSO and audit requirements.
- Task-management system and its API (for roadmap/Gantt later).
- Allowed UI editing mode (GitLab MR only vs moderated Confluence import).
- Whether deployment is single-user engineering tool or multiuser product (changes auth priorities).

Do not block the local synthetic MVP on these decisions.

## Decisions taken during the first implementation

| ID | Decision | Why | Revisit when |
|---|---|---|---|
| ADR-009 | Local revision = `sha256:` prefix of the file content; GitLab revision = file `last_commit_id` | Conflict detection works offline and maps 1:1 to GitLab's `last_commit_id` precondition for commits | Git history is needed locally |
| ADR-010 | Mock assistant is strictly extractive; `supported` only when one source covers the question's terms; unknown acronyms/IDs → `insufficient_evidence` | No hallucinated answers in demo mode; deterministic and testable | A real internal model is approved |
| ADR-011 | Drafts/deprecated are searchable but excluded from evidence by default and reported as `excluded_sources` | Users see that a draft exists without the assistant treating it as authoritative | Review policy changes |
| ADR-012 | In Docker the backend is not published and sits on an `internal` network; egress is an explicit compose override | "Deny internet egress by default" enforced by the runtime, not only by code | On-prem topology is approved |
| ADR-013 | Confluence MCP tools are mapped by explicit configuration and verified against `tools/list` | The bank's MCP server and tool names are unknown; never guess | The approved MCP server is documented |
| ADR-014 | Sanitize twice (nh3 on the server, DOMPurify in the browser) and serve a strict CSP; fonts are bundled | Defence in depth against XSS; no third-party requests from the UI | — |
| ADR-015 | Secrets only as files (`*_FILE`) mounted read-only from outside the repository; corporate CA via `*_CA_BUNDLE`; `HTTP(S)_PROXY` ignored | No secrets in env dumps, git or images; outbound hosts stay explicit | A corporate proxy is mandatory |
| ADR-016 | Undocumented GitLab answers (existing branch, rejected commit, duplicate MR) are resolved by re-reading state, not by parsing error text | Error wording is not part of the API contract | GitLab documents these responses |
| ADR-017 | MCP result format is configured (`CONFLUENCE_MCP_RESULT_MAP`) and verified with replayable recorded scenarios | The bank's MCP server output is unknown; adapting must not need code changes | The MCP server contract is documented |
| ADR-018 | Existing variable names are kept (`KNOWLEDGE_BACKEND`, `GITLAB_URL`, `GITLAB_KNOWLEDGE_PATH`, `GITLAB_TOKEN_FILE`) instead of introducing `KNOWLEDGE_PROVIDER` / `GITLAB_BASE_URL` / `GITLAB_DOCS_PATH` aliases | One contract, no duplicated configuration; mapping is documented in INTEGRATION_READINESS.md | — |
| ADR-019 | GitLab sync is incremental: branch-head probe, then only files with a changed blob id are re-read; removed files leave the index; the index stores source + revision per document | Bounded load on GitLab, the index never holds an old revision as current | Very large repositories need the compare API or webhooks |
| ADR-020 | On a GitLab outage the last snapshot is served and marked stale; on 401/403/404 the cache is dropped (fail closed) | Availability for reading without presenting stale data as current; revoked access is honoured | Per-user ACLs (PB-03) |
| ADR-021 | Proposal lifecycle `draft → ready_for_review → submitting → submitted_to_gitlab → merged`, with `conflict`, `submission_failed`, `rejected`; MR state stored separately; `merged` only after GitLab confirms it | "Ready" ≠ MR ≠ approval; the UI and audit trail must not overstate the state | — |
| ADR-022 | One deterministic branch per proposal `kb/update/<ID>-<8 hex>`; an existing branch is reused only if it contains nothing but this proposal's commit (`Proposal-Id` trailer) | Retries are idempotent; colliding or foreign branches are never overwritten | — |
| ADR-023 | Writes are never retried automatically; a timeout/5xx on a POST is resolved by inspecting branch/commit/MR state, and an unresolved outcome is stored as `uncertain` (blocks local reject until checked) | A lost answer must not produce duplicate commits/MRs or orphaned MRs hidden by a local "rejected" | — |
| ADR-024 | Every API route declares an `Action`; decisions go through an `AuthorizationPolicy`; only `LocalDemoPolicy` (single loopback operator) exists, anything else is `DenyAllPolicy` | Enforcement points are ready and tested before SSO/RBAC exists; no "open to everyone" mode | SSO/RBAC (PB-01/02) |
| ADR-025 | Plain `http` is accepted only for loopback hosts (test doubles); TLS is never disabled for real hosts | Allows offline E2E with a local GitLab mock without weakening real connections | — |
| ADR-026 | The GitLab TEST DOUBLE (`backend/tests/support/gitlab_mock.py`) is stateful (commits, branches, protected `main`, compare, MRs, fault injection) and lives in tests only | Realistic end-to-end lifecycle offline; clearly not a functional integration and never shipped in the image | Live validation on the test GitLab |
| ADR-027 | Confluence MCP auth model is explicit (`CONFLUENCE_MCP_AUTH_MODEL=service_account`); `per_user` is refused until SSO exists | A shared token cannot enforce per-user ACLs — the limitation is visible in status and preflight | MCP with user identity propagation |
