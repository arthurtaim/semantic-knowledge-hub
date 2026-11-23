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
- Render Markdown safely; sanitize raw HTML; prevent XSS in excerpts and document titles.
- Configure CORS narrowly; robust request/response validation and CSRF/session protection before multiuser deployment.
- Strict outbound allowlist for LLM, GitLab and Confluence endpoints; prevent SSRF and arbitrary URL fetches.
- Use timeouts, response-size limits, retry-with-backoff and clear disabled states.
- Never run code embedded in documents. No Git push or privileged actions without explicit approval.
- Secret handling through environment injection or secrets manager. `.env`, token files, caches, raw external content and `workspace/` excluded from GitHub. Verify CI does not print secrets.

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
