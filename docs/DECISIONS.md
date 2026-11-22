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
