# Claude Code — project operating instructions

You are building **Semantic Knowledge Hub**, an AI-native knowledge-base application for a bank's semantic-layer engineering team. This repository lives in **GitHub and contains application code only**. The team's working documentation belongs in a **separate GitLab repository**. **Confluence Data Center** provides corporate knowledge via an approved read-only MCP connector and later serves as a published view of selected approved GitLab documents.

## Required first actions
1. Read `START_HERE.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/API_CONTRACTS.md`, `docs/TEST_PLAN.md`, and `docs/IMPLEMENTATION_PLAN.md` before coding.
2. Inspect the repository before making changes. Do not assume code exists. Work in iterative, verifiable milestones, implementing the requested MVP in this session when practical.
3. Use synthetic fixtures only. Never upload bank documents, tokens, credentials, database dumps, schema exports or internal URLs to GitHub.
4. Treat GitHub and GitLab as **different systems with different purposes**. Never store or sync real team knowledge to the application-code GitHub repository.
5. Prioritize a working local application over additional planning documents. Do not ask for corporate credentials to build the local MVP.

## Key decisions
- Application code: GitHub (this repo).
- Knowledge source of truth: GitLab repository, with `LocalKnowledgeRepository` used for development.
- Confluence Data Center: read-only corporate search via approved MCP; subsequent optional controlled publication of approved GitLab docs.
- Current coding assistant: Claude Code. Future agent platform: GigaCode. **Do not couple application logic to Claude Code or assume a GigaCode REST agent API exists.**
- AI: runtime provider abstraction. Default `mock`/disabled; optional internal **OpenAI-compatible endpoint** via explicit configuration. No default outbound AI service.
- UI language: Russian by default, code and API identifiers in English.
- Technology direction: FastAPI + Python 3.12+, React + TypeScript + Vite, SQLite FTS5 for local search, Docker Compose for local deployment. No vector DB or orchestration framework in MVP.

## Engineering expectations
- Implement small vertical slices with tests and run them. Never claim success without actual command output.
- Use strict typed interfaces, explicit configuration, logging without sensitive bodies, input validation, bounded requests/timeouts and clear errors.
- Every search/answer result must carry citations/provenance and indicate its source (`gitlab`, `local`, `confluence`).
- Never make AI-generated drafts authoritative automatically. Changes require review; publication is opt-in and off by default.
- No direct filesystem access outside configured knowledge root. Validate path traversal and symlinks.
- Do not create fake functional integrations. Mark unconfigured integrations as unavailable in the UI and API. For testing use clearly labeled mocks.
- No user-provided arbitrary URL fetching (SSRF). Network integrations use configured allowlisted hosts.
- Do not bypass organizational authentication, RBAC, approval, or repository branch protection.

## Definition of done for first local MVP
- `docker compose up --build` works using synthetic fixtures and no external services (or documented equivalent if Docker unavailable).
- Web UI has navigation, searchable list, Markdown viewer with metadata, AI panel in demo mode, source/citation display and a reviewable draft/diff flow.
- Backend exposes `/api/health`, `/api/documents`, `/api/search`, `/api/assistant/ask`, `/api/integrations/status` and draft endpoints; no hallucinated answers from mock provider.
- Unit/integration tests pass; basic UI smoke test passes; README has exact local startup steps; `.env.example` has safe placeholders.
- Real GitLab and Confluence integrations have well-defined adapters/contracts and mocked tests; external live connectivity is **not** required for the offline MVP.

## Required reporting after each milestone
Report files changed, implemented behavior, commands executed, test results, remaining blockers and next small step. Continue implementing rather than only describing what to do.

See `AGENTS.md` for shared cross-agent rules and `docs/IMPLEMENTATION_PLAN.md` for implementation order.
