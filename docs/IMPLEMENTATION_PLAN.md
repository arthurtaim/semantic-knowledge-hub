# Implementation plan for Claude Code

This is an **execution plan**. Build a functioning application through increments. Do not stop after creating a planning document. Update the README with exact commands and logs/results from what was actually tested.

## Milestone M0 — Repo setup and bootable skeleton
- Inspect all starter files and summarize architecture in <=10 bullets.
- Scaffold `backend/` (FastAPI/Pydantic), `frontend/` (React/TS/Vite), `tests/`, `docker-compose.yml`, Dockerfiles, environment loader.
- Add lint/test commands and `GET /api/health`.
- Docker Compose local services must be published on `127.0.0.1` host only; backend can listen on container interface internally. No public endpoints by default.
- Add developer `.env.example` handling; never require private credentials.
- Execute startup and health tests. If tools (Docker, Node) unavailable, provide repeatable command list, run all tests supported by environment, and report limits without claiming a successful run.

**Exit:** backend boots, frontend loads, health returns expected JSON.

## Milestone M1 — Local knowledge repository + UI
- Provide synthetic fixture documents under `fixtures/knowledge`, copy/seed them to ignored `workspace/knowledge` for local use. Do not accidentally commit workspace.
- Frontmatter parser/validator, stable IDs, metadata/provenance objects, safe Markdown renderer, search service (SQLite FTS5 or test-verified deterministic fallback).
- Endpoints `/api/documents`, `/api/documents/{id}`, `/api/search`, integration status.
- Build navigation UI, category filters, document detail and meaningful demo/source labels.
- Tests for parsing, filtering, empty search, duplicate IDs, invalid path, XSS, permissions/feature flags.

**Exit:** searchable document explorer, synthetic ARIS overview openable, no real network calls.

## Milestone M2 — AI-native grounded Q&A
- Implement `AIProvider` abstraction and deterministic `MockAIProvider`. Mock MUST be visibly labeled demo and never pretend to know bank facts.
- Retrieval pipeline with source-ranked excerpts and stable citation IDs.
- Implement `/api/assistant/ask`; add chat UI with clickable citations, source scope, missing-evidence behavior.
- Optional internal API adapter (OpenAI-compatible only if explicitly enabled). Use timeout and safety constraints; tests use mock HTTP transport not a real endpoint.
- Test unsupported questions, citation validity and prompt injection in retrieved text.

**Exit:** local ask workflow with grounded demo evidence, no paid/external API.

## Milestone M3 — Reviewable drafts and diffs
- Create local proposal records referencing original revision; compute unified diff.
- New/edited Markdown undergoes frontmatter/schema validation. UI displays before/after and warnings.
- Add proposal routes and review UI. Rejection/mark ready does not modify the canonical document.
- Conflict tests (`base_revision` mismatch -> 409), unsafe content tests, no silent writes.

**Exit:** end-to-end draft -> inspect diff -> reject / ready-for-review works offline.

## Milestone M4 — External connectors, mocked first
- Define adapters `GitLabKnowledgeRepository`, `GitLabMRPublisher`, `ConfluenceMCPConnector` with config validation, disabled states and tests using fake HTTP/MCP responses.
- Implement read-only Confluence tool discovery (not guessed names), tool mapping config and error behavior; live mode only when valid approved configuration is present.
- Implement GitLab read and branch/MR proposal capability if correct GitLab API details are verified and policy allows; leave write disabled by default.
- Add integration status and no secret leakage. Live tests optional and require explicit operator enablement.

**Exit:** mock-based contract tests pass; app still works with external connectors disabled.

## Milestone M5 — GitLab -> Confluence publication (later phase)
- Publisher must be feature-gated and separate from MCP read connector.
- Verify document is approved on protected GitLab branch; map document to page ID.
- Version and content-hash guard; render supported Markdown; reject conflicting edits.
- Update existing page idempotently; never duplicate on retries.
- Add dry-run preview and explicit human approval. Tests simulate first publish, update, retry and conflict.

**Exit:** acceptance in nonproduction integration environment only.

## Milestone M6 — On-prem deployment and GigaCode migration (later)
- SSO, RBAC, per-user Confluence ACL, secrets manager, observability and approved network topology.
- Verify GigaCode execution interface actually provided by bank (CLI/MCP/internal API). Implement new `AIProvider` or tool adapter only after confirmation.
- Validate data stays within agreed bank perimeter. Retain all GitLab knowledge and Confluence page IDs.

**Exit:** separate production security review; never infer it from demo success.

## Engineering sequence
- After each milestone: run tests, build, smoke test, fix broken behavior, update README and present results.
- Avoid giant up-front refactors; keep modules replaceable. Do not add unnecessary packages or deep framework abstractions.
- If uncertain about nonessential visual details, choose sensible defaults and proceed.
- For blockers requiring secrets/permissions, implement safe mocks and continue working on independent milestones.
