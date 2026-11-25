# Security requirements and operating assumptions

These are non-negotiable for a prototype intended eventually for a bank. The **local MVP is not production-safe** merely because it uses Docker or runs on an internal server.

## Data classification
- GitHub is for product code, tests and **fictional/synthetic fixtures only**, preferably private repository.
- Real team documents/models/schema details and bank-sensitive metadata belong in corporate-approved GitLab. Actual customer records and physical database exports should remain in their separately approved data systems.
- Confluence Data Center corporate pages are retrieved under the requester's authorization; do not replicate to GitHub or shared unprotected caches.
- Local demo workspace under ignored folder; test docs must clearly identify as synthetic.

## AI boundary
- Claude Code being installed on a server **does not prove local model execution or local data processing**. Establish actual inference provider, egress, logging and contractual controls before using bank data.
- By default, mock provider and no outbound AI requests. Enable real model only with explicit company-approved internal URL and approved credentials.
- Retrieved documents are untrusted content. Defend against prompt injection, tool misuse and exfiltration attempts. Documents never elevate to developer/system instructions.
- Never let model independently run shell commands, execute SQL against databases, publish documents, set approval status or open unrestricted external links.

## Authentication and authorization
- Local MVP: one developer, localhost-only, clearly labeled `DEMO`, no fake SSO.
- Production: corporate SSO, per-user authorization for GitLab and Confluence, backend-enforced content filtering, least privileged service roles and audit trail.
- `AUTH_MODE=local_demo` MUST be rejected for non-local or publicly exposed deployment. Inside Docker the service may listen on its container interface, but host port publishing MUST be loopback-only (`127.0.0.1:HOST_PORT:CONTAINER_PORT`), with no reverse proxy exposing demo mode. Production must require SSO/RBAC.
- Do not infer that MCP client-side tool filtering enforces server-side access. Validate principal/context at the backend/MCP server.

## Code and runtime
- Validate document IDs and resolved paths, reject `..` traversal, malicious symlinks and excessive file sizes.
- Render Markdown safely; sanitize raw HTML; prevent XSS in excerpts and document titles. Assistant answers are
  untrusted model text even after citation checks: rendered from a Markdown AST with raw HTML shown as text, links
  limited to http(s), mailto and app paths, no remote images, markers only for server-verified references
  (`docs/UI_REDESIGN.md` «Ответ ассистента в Markdown»).
- Configure CORS narrowly; robust request/response validation and CSRF/session protection before multiuser deployment.
- Strict outbound allowlist for LLM, GitLab and Confluence endpoints; prevent SSRF and arbitrary URL fetches.
- Use timeouts, response-size limits, retry-with-backoff and clear disabled states.
- Never run code embedded in documents. No Git push or privileged actions without explicit approval.
- Secret handling through environment injection or secrets manager. `.env`, token files, caches, raw external content and `workspace/` excluded from GitHub. Verify CI does not print secrets.

## Chat history (assistant conversations)
- **What is stored** (app-state SQLite on the persistent volume, tables `assistant_conversations`,
  `assistant_turns`; `docs/API_CONTRACTS.md` v0.7): per turn the user's question and the request context that matters
  (skill, scope, chosen document ids and titles, attachment ids and names, a selection *reference* — document,
  section, line count), timestamps, the status, and for a completed turn the final `AskResponse` exactly as it was
  sent (answer, citations with their verified quotes, system facts, provenance, warnings, proposal reference, mode,
  index generation) plus the ids of the documents / Confluence pages / files it relies on. A failed turn keeps only
  the error code and the server's message.
- **Not stored**: prompts or instructions sent to the model, retrieved passages beyond what the response already
  contains, tokens or credentials, the `history` a client sends, attachment contents (the extracted text stays in
  `assistant_attachments` with its own 24 h TTL), selection text. Bodies are never logged (the log line says the turn
  number, the status and the size).
- **Scope, not authentication.** A conversation belongs to the server's user id AND a random per-browser id
  (`X-SKH-Browser`, 128 bits, kept in `localStorage`). It exists because the demo stand has one shared login: without
  it every browser would see every dialog. Anyone who can read that browser's storage (or the header in transit) can
  read its history; it does not protect against a malicious client of the same account. With real SSO the user id
  is the boundary and the browser id only separates a person's own devices. Another browser, a missing or malformed
  id, or another user gets nothing listed and `404` for a guessed conversation id (the same answer as an unknown id).
- **Reading re-checks access.** An answer whose evidence (a cited or chosen document, a document named by a system
  fact, a Confluence page that fails the access + version re-check) the reader can no longer see is withheld with a
  neutral note — never shown, never partially shown, no title, id or count of what is hidden. A stored answer is never
  re-run by itself; a changed index generation is said («ответ дан по поколению gN; база с тех пор обновлена»).
  Excerpts of files the server no longer keeps are not shown. The answer text itself is model output kept as sent:
  it may paraphrase a file or a document the reader still sees, so deleting the conversation is how a user removes it.
- **Retention and limits**: `ASSISTANT_HISTORY_RETENTION_DAYS` (default 30; purged on access), 100 conversations per
  user and browser, 50 turns per conversation, 512 KB per stored answer (`ASSISTANT_HISTORY_*`); «Удалить диалог»
  (with its files) and «Очистить историю» delete on the server at once. `ASSISTANT_HISTORY_ENABLED=false` stores
  nothing. Retention for a production deployment must be agreed with the bank's stakeholders like every other log.

## Auditing and provenance
Log operation timestamp, user ID (when configured), source IDs, document revision, integration status and proposal status; redact content and tokens by default. Record approvals and publication mappings. Define retention with bank stakeholders before production.

## Go-live gates
1. Architecture and data flow reviewed by security.
2. SSO/RBAC and permission-isolation tests passed.
3. On-prem data-processing / model endpoints authorized.
4. Backups, retention and monitoring agreed.
5. Security scans, dependency review and operational runbook completed.
6. Confluence/GitLab write permissions scoped and only used after review.

Do not claim these gates are satisfied in the MVP.
