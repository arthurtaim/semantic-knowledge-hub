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
| ADR-018 | Existing variable names are kept (`KNOWLEDGE_BACKEND`, `GITLAB_URL`, `GITLAB_KNOWLEDGE_PATH`, `GITLAB_TOKEN_FILE`) instead of introducing `KNOWLEDGE_PROVIDER` / `GITLAB_BASE_URL` / `GITLAB_DOCS_PATH` aliases | One contract, no duplicated configuration; mapping is documented in M4_M5_INTEGRATION_READINESS.md | — |
| ADR-019 | GitLab sync is incremental: branch-head probe, then only files with a changed blob id are re-read; removed files leave the index; the index stores source + revision per document | Bounded load on GitLab, the index never holds an old revision as current | Very large repositories need the compare API or webhooks |
| ADR-020 | On a GitLab outage the last snapshot is served and marked stale; on 401/403/404 the cache is dropped (fail closed) | Availability for reading without presenting stale data as current; revoked access is honoured | Per-user ACLs (PB-03) |
| ADR-021 | Proposal lifecycle `draft → ready_for_review → submitting → submitted_to_gitlab → merged`, with `conflict`, `submission_failed`, `rejected`; MR state stored separately; `merged` only after GitLab confirms it | "Ready" ≠ MR ≠ approval; the UI and audit trail must not overstate the state | — |
| ADR-022 | One deterministic branch per proposal `kb/update/<ID>-<8 hex>`; an existing branch is reused only if it contains nothing but this proposal's commit (`Proposal-Id` trailer) | Retries are idempotent; colliding or foreign branches are never overwritten | — |
| ADR-023 | Writes are never retried automatically; a timeout/5xx on a POST is resolved by inspecting branch/commit/MR state, and an unresolved outcome is stored as `uncertain` (blocks local reject until checked) | A lost answer must not produce duplicate commits/MRs or orphaned MRs hidden by a local "rejected" | — |
| ADR-024 | Every API route declares an `Action`; decisions go through an `AuthorizationPolicy`; only `LocalDemoPolicy` (single loopback operator) exists, anything else is `DenyAllPolicy` | Enforcement points are ready and tested before SSO/RBAC exists; no "open to everyone" mode | SSO/RBAC (PB-01/02) |
| ADR-025 | Plain `http` is accepted only for loopback hosts (test doubles); TLS is never disabled for real hosts | Allows offline E2E with a local GitLab mock without weakening real connections | — |
| ADR-026 | The GitLab TEST DOUBLE (`backend/tests/support/gitlab_mock.py`) is stateful (commits, branches, protected `main`, compare, MRs, fault injection) and lives in tests only | Realistic end-to-end lifecycle offline; clearly not a functional integration and never shipped in the image | Live validation on the test GitLab |
| ADR-027 | Confluence MCP auth model is explicit (`CONFLUENCE_MCP_AUTH_MODEL=service_account`); `per_user` is refused until SSO exists | A shared token cannot enforce per-user ACLs — the limitation is visible in status and preflight | MCP with user identity propagation |

## Decisions taken in M4.6 / M4 readiness / M5

| ID | Decision | Why | Revisit when |
|---|---|---|---|
| ADR-028 | Explicit run mode `INTEGRATION_PROFILE=offline\|integration_mock\|live_read_only\|live_write_staging`, enforced at startup; test doubles are declared in `MOCK_SERVICE_HOSTS`, which accepts only loopback, reserved domains (`*.example`, `*.test`, `*.invalid`, `*.localhost`) or single-label `<name>-mock` Docker names | Writes to a mock must never be able to reach a corporate host; a real target can never be labelled "mock"; `offline` stays network-free | Corporate deployment topology is approved |
| ADR-029 | A new document is a proposal with `operation=create` on the same review → branch → MR → merge path as `update`; drafts are editable and persistent in the backend store (`PUT` with `expected_version`, `DELETE` before submission) | One governed path for every change; no hidden writes; lost updates between tabs/people surface as `409`, never as silent overwrites | Collaborative real-time editing is required |
| ADR-030 | Document templates are Markdown files with a YAML header (`app/document_templates/` or `DOCUMENT_TEMPLATES_DIR`); `##` headings define the required sections; the application generates front matter from form fields via the YAML library | Extending templates must not need UI code changes; users never edit YAML; serialization prevents injection through field values | Templates must be managed by non-developers in GitLab |
| ADR-031 | AI-assisted authoring contract `AuthoringRequest`/`AuthoringDraft` (`AIProvider.draft_document`): only approved team documents (scope `team`) as untrusted references; the server re-verifies every citation verbatim; the demo provider only structures the template and quotes; the result is a non-stored suggestion that can never be `approved` | Honest demo without an LLM; the same contract is ready for a future GigaCode/LLM provider; no invented facts become knowledge | An approved internal model or GigaCode interface exists |
| ADR-032 | Publication writes use the Confluence **Data Center REST API** (`/rest/api`) with a dedicated publishing token; the MCP connector stays read-only; the Cloud v2 API is not used | MCP tools give no guaranteed write/version/property semantics; separate credentials limit blast radius; the target is Data Center | The bank provides a supported write interface |
| ADR-033 | Merge evidence for publication = GitLab's `GET /projects/:id/repository/commits/:sha/merge_requests` returning a merged MR into the knowledge branch for the document's current revision | Only GitLab may state that a revision was reviewed and merged; UI flags or local proposal state are not evidence | Squash/rebase merge strategies prove incompatible during live validation |
| ADR-034 | Page ownership = durable mapping `(project_id, lower(document_id)) → page_id` **and** content property `skh-managed-document` on the page; a title match alone is never trusted; `confluence_page_id` in front matter is ignored; no API accepts a page ID | Prevents overwriting foreign or look-alike pages; lets a lost "create" answer be reconciled without duplicates | Confluence offers a stronger managed-content mechanism |
| ADR-035 | Publication jobs run synchronously in the API request with durable state in SQLite (`publications.sqlite3`), one active job per document (partial unique index + compare-and-set transitions), restart recovery (`publishing` → `result_unknown`) — no Redis/Celery/worker | Single-instance MVP; no extra infrastructure; state survives restarts; double publishing is impossible | Multi-instance deployment or high publication volume (PB-11) |
| ADR-036 | Dry-run issues read requests only and is mandatory; publishing is a separate explicit action that re-plans first and refuses to write if the plan changed (`409 plan_changed`); writes are never retried blindly — after a lost answer Confluence is inspected | A human sees exactly what will be written; no stale previews are executed; lost answers never create duplicates | — |
| ADR-037 | "Acknowledge manual edit" is the only path to overwrite a manually edited page: it rebases the mapping on the current page (no write) and forces a fresh dry-run that shows what will be replaced, followed by an explicit publish | Manual edits in Confluence are never lost silently; the decision is human and visible | Bidirectional Confluence → GitLab import is implemented |
| ADR-038 | `docs/INTEGRATION_READINESS.md` renamed to `docs/M4_M5_INTEGRATION_READINESS.md` (via `git mv`) and extended with run modes, publication variables, corporate inputs and post-live-validation adaptations | One readiness document for M4 and M5 as named in the hand-off; history preserved | — |

## Decisions taken for the Claude Code CLI personal test

| ID | Decision | Why | Revisit when |
|---|---|---|---|
| ADR-039 | An EXPERIMENTAL `claude_cli` AIProvider uses the owner's Claude subscription through the Claude Code CLI (`claude -p --output-format stream-json`), not the Anthropic API; single operator, synthetic data, explicit `CLAUDE_CLI_PERSONAL_USE_ACK`, refused in `offline` | Test a real model in the product without an API key or a corporate endpoint; subscription auth is for personal use only, so the provider must never become a shared service | An approved corporate provider (GigaCode / internal API) exists |
| ADR-040 | The CLI runs in a separate worker container reached only by the backend over an internal network; the backend keeps no Claude credentials and no egress; the worker disables all tools/MCP/settings/session persistence, aborts on any tool sign, uses a per-request empty directory and an allow-listed environment | Defence in depth: even a manipulated prompt cannot make the model act on the server, GitLab, Confluence or other apps | The CLI offers a stronger sandbox, or the provider is removed |
| ADR-041 | Streaming is an optional provider capability (`stream_answer`) exposed as `POST /api/assistant/ask/stream` (NDJSON: status → preliminary deltas → one validated `final`); conversation history is sent by the client and never stored | Keeps `AIProvider` unchanged and every provider usable from the same UI; preliminary text is labelled, only the validated final answer counts | Server-side conversations are needed (with SSO) |
| ADR-042 | The worker image pins the official Claude Code release binary (version + sha256 from the release manifest) instead of reusing another project's CLI copy or credentials | Isolation from the other project on the server; reproducible, verifiable build | Version bump: update version and both checksums together |
