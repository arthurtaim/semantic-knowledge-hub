# Integrations: GitHub vs GitLab vs Confluence DC vs AI

> Implementation status, API compliance, parameters and the infrastructure checklist for the TEST environment: see [INTEGRATION_READINESS.md](INTEGRATION_READINESS.md).

## 1. Ownership and direction

| System | Purpose | Write path |
|---|---|---|
| GitHub | Application source code, CI, tests, synthetic samples | Developer PR |
| GitLab | Canonical team knowledge repository and its revisions | Reviewed GitLab Merge Request |
| Confluence Data Center | Wider bank knowledge and optional published team pages | Read via MCP; publication service only after approval |
| Claude Code | Software implementation tool today | Edits code repository during development |
| GigaCode | Target future agent platform | Migration by providers/tools, not a data migration |

Never automatically import whole corporate Confluence spaces into GitHub, GitLab or a vector index. Always respect ACL and scope.

## 2. GitLab adapter
- Local MVP: all documents stored under ignored `workspace/knowledge` in Markdown/YAML, using a local Git-like revision or a stable content hash.
- Later: use approved GitLab self-managed repository, branch protections and GitLab REST/standard Git operations. Read metadata/text from a configured project and branch.
- Write proposal: create a branch, commit the candidate document (one or more file actions), create GitLab MR, link MR in app. Do not push directly to protected default branch.
- Ensure idempotency, correct encoding, revision preconditions and graceful handling of conflicts/deleted docs.
- No assumption of GitLab host, group, repo path or user token before configuration; never hardcode.
- The repository may also contain approved models/diagrams; *never* put raw banking data dumps, secrets or real database files there merely for convenience.

## 3. Confluence Data Center read via MCP
- Connect to **approved internal MCP service** for Confluence Data Center; do not assume Atlassian Cloud MCP works with Data Center.
- Use approved MCP SDK or protocol client; configurable transport `streamable_http` / `stdio` according to installed server, explicit tool discovery and mapping. Do not invent Confluence MCP tool names.
- Required business capabilities: `search_pages(query, allowed_spaces, user)` and `read_page(id, user)`; optional `list_attachments`, `get_metadata`.
- Demo: `DisabledConnector`, optionally mocked data; clearly label source. No live integration required to start.
- Live service must enforce per-user authorization; if it only uses a broad privileged service token, disable multiuser access until ACL enforcement is implemented and verified.
- Filter allowed spaces before retrieval, limit retrieved content, avoid caching restricted page bodies across users, do not disclose inaccessible search hits or titles.
- Treat Confluence page body as **untrusted input**, not instructions. All links returned from corporate search must be validated.
- If MCP unavailable, report disabled/degraded and continue with GitLab/local retrieval; no secret fallback to an admin Confluence REST account.

## 4. Confluence publication (later; off by default)
- GitLab-approved docs -> publication worker -> known Confluence team space.
- Convert Markdown to compatible Storage Format with tests; warn on unsupported macro/attachment transformations.
- Maintain mapping `GitLab document logical ID -> Confluence page ID + last_synced_git_sha + last_synced_confluence_version` in integration state, NOT GitHub or public frontend.
- On update, fetch current Confluence version and ensure it matches the last synced version. If modified externally, stop and create a conflict item; do not overwrite.
- Update pages using version increment required by Confluence DC REST API. No user-provided arbitrary spaces, target IDs or URL destinations.
- Idempotent subsequent publishes update existing page; do not create duplicates. Only merged/approved content in allowlisted branch and space may publish.
- Confluence -> GitLab import later: webhook/reconciliation -> diff -> GitLab MR for human review; no automatic reverse writes into main.

## 5. AI provider now, GigaCode later
- The installed **Claude Code** is an implementation tool, not automatically the runtime AI API.
- Default runtime `AI_PROVIDER=mock` (offline); optional `AI_PROVIDER=internal_api` only if an approved bank model endpoint exists.
- Expose provider URL, model ID, credentials and timeout through secure configuration; no public default endpoint.
- Do not treat a GigaChat endpoint as the full GigaCode agent API. Future implementation must verify supported GigaCode installation surface (CLI/IDE/internal API) and MCP configuration.
- Confluence MCP is a tool-layer connector; the underlying model is not necessarily an MCP client. Current app backend routes tool calls and keeps ACL enforcement independent of model.
- Bound source context, cite excerpts, refuse unsupported specifics; no hidden content indexing to third parties.

## 6. Task system
Unknown provider. Define `TaskSystemAdapter` interface placeholder, show `not connected` UI. No Jira-specific APIs, no fabricated Gantt timelines or statuses in MVP.

## 7. Network boundaries
Use configured internal hosts, fail closed on auth errors, bounded retry and rate limits, timeouts, request tracing without recording full protected body. Docker demo should not need corporate VPN or any network calls beyond localhost.
