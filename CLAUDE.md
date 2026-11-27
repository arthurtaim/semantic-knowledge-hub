# Claude Code — project operating instructions

@AGENTS.md

## 1. Mission and constraints
You are building **Semantic Knowledge Hub (SKH)**, an AI-native knowledge-base application for a bank's
semantic-layer engineering team. This repository lives in **GitHub and contains application code only**.
The team's working documentation belongs in a **separate GitLab repository**. **Confluence Data Center**
provides corporate knowledge via an approved read-only MCP connector and later serves as a published view of
selected approved GitLab documents. Demo and tests use **synthetic fixtures only** (`synthetic: true`); never
upload bank documents, tokens, credentials, database dumps, schema exports or internal URLs to GitHub.
Prioritize a working application over more planning documents; do not ask for corporate credentials.
UI language is Russian by default; code, API and identifiers are English. Read `README.md`,
`docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md` and `docs/API_CONTRACTS.md` before coding.

## 2. Repository layout
- `backend/app` — FastAPI: `api/` routes, `services/` (knowledge, retrieval, assistant, graph, external,
  discovery, authoring, proposals, publications), `adapters/` (knowledge local/GitLab, search SQLite FTS5,
  AI mock/internal API/Claude CLI, Confluence MCP/mock/REST), `domain/` (schema, models, templates,
  template registry, dictionary, instructions), `document_templates/` (+ `history/`), `search_dictionary/`,
  `assistant_instructions/` (runtime policy of the in-app assistant), `evaluation/`, `tools/`.
- `backend/claude_worker` — isolated Claude Code CLI worker (personal test stack only).
- `frontend/src` — React + TypeScript + Vite (one stylesheet `styles/app.css`).
- `fixtures/knowledge` (83 synthetic docs: 9 core SEM-* at the top, DEMO-* in sub-folders),
  `fixtures/eval` (gold cases), `fixtures/knowledge_updates` (mutable sync snapshots),
  `fixtures/confluence_mock` (synthetic Confluence corpus), `deploy/`, `docs/` (index `docs/README.md`; running, tests,
  configuration — `docs/DEVELOPMENT.md`), `reports/` (stage summary `reports/README.md`; `knowledge-eval/` outputs).

## 3. Architecture map (read the docs before changing a part)
Markdown + YAML (`docs/DOCUMENT_SCHEMA.md`, `docs/MOCK_KNOWLEDGE_BASE.md`) → KnowledgeRepository →
one snapshot → index generation (FTS5 + manifest) → retrieval pipeline and typed graph
(`docs/SEARCH_SYNC_TEMPLATES.md`, `docs/KNOWLEDGE_GRAPH.md`) → AssistantService with server-verified
citations, optional external Confluence evidence and discovery memory (`docs/EXTERNAL_RAG.md`) →
AIProvider (mock default; internal OpenAI-compatible endpoint; Claude CLI personal test only,
`docs/CLAUDE_CODE_CLI_INTEGRATION.md`; GigaCode later, `docs/GIGACODE_MIGRATION.md`). Templates: versioned
registry. GitLab MR workflow and Confluence publication: `docs/GITLAB_KNOWLEDGE_WORKFLOW.md`,
`docs/CONFLUENCE_PUBLISHING_ARCHITECTURE.md`. Overall: `docs/ARCHITECTURE.md`.
M5.6.3: metadata without YAML + WikiLinks/backlinks (`docs/METADATA_AND_LINKS.md`), Template Hub
(`docs/TEMPLATE_HUB.md`), AI-first proposals with Accept/Reject (`docs/AI_WORKFLOWS.md`).
Adaptive RAG: the local-first evidence gate decides «Оба» → Confluence with ONE small model decision
(weak-model contract, `docs/ADAPTIVE_RAG.md`).
M6: native Work Management — projects/tasks/FS scheduling/identity gate, task↔document links (reader-scoped),
`work_inspect` (read-only M5.7 tool) and typed «AI план» proposals in `backend/app/work/` (`docs/WORK_MANAGEMENT.md`).
M7: chat work skills (analyze / plan WAP / change-set WCP of existing tasks, schema v4) over the same work services;
the chat never applies — a person confirms in the project review (`docs/WORK_CHAT_SKILLS.md`).
«Создать задачу» (2026-11-27): a task-draft card from a chat phrase (auto-started by a rule); the card's button creates the
task via the regular task API; dates enter tasks only from verified quotes of the request (`WORK_CHAT_SKILLS.md` §12).
Stack: FastAPI + Python 3.12, React + TypeScript + Vite, SQLite FTS5, Docker Compose. No default outbound
AI service; no embeddings, vector DB, LLM re-ranker or orchestration framework by default. Claude Code is the
current developer agent, GigaCode the future one — never couple app logic to either, never assume a
GigaCode REST agent API exists. In-app assistant policy: `docs/ASSISTANT_INSTRUCTIONS.md`; operator
procedures: `docs/OPERATOR_RUNBOOKS.md`.

## 4. Source of truth and lifecycle
draft → proposal / MR → human review → merge in GitLab → approved → indexed (new generation) → optionally
published to Confluence. GitLab and Confluence integrations may be test doubles; mark unconfigured ones as
unavailable, never fake them. AI output is never authoritative: changes need review, publication is opt-in.
Every search/answer result carries provenance (`local`, `gitlab`, `confluence`; namespaced source id,
revision, fragment).

## 5. Commands (all exist; run them, paste real output)
`make setup` · `make check` (ruff, mypy strict, tsc, eslint, pytest, vitest) · `make e2e` ·
`make preflight` · `make mock-kb-validate` · `make mock-kb-sync` · `make knowledge-eval` (deterministic,
216 cases) · `make work-eval` (M6, deterministic) · `make knowledge-eval-live` (opt-in, `SKH_LIVE_EVAL=1`) ·
`make claude-test-*` (personal stack).
Hetzner test stack: `deploy/claude-test/deploy.sh` (see `docs/CLAUDE_CODE_CLI_INTEGRATION.md`).

## 6. Changing schemas, documents and templates
- Stable document ids never change; renames keep the id; `version` (MAJOR.MINOR) is the human version,
  `revision` is computed (content hash / commit). Superseded = `deprecated` + a `supersedes` edge.
- Relations are declared in frontmatter (`relations:` typed, `related_ids` plain) — never inferred by a model.
- After any document change: `make mock-kb-validate`, then a sync, then `make knowledge-eval`; a stale term,
  edge or citation is a bug. A new template or version is a file (`document_templates/`, old versions in
  `history/`); existing drafts keep their version.
- Changing `search_dictionary/dictionary.yaml` or retrieval weights requires a before/after eval; never tune
  on holdout cases.

## 7. Security guardrails
No secrets in Git; no corporate data to Claude or any test service; synthetic data only on personal
servers. The in-app AI has no shell, file, GitLab, Confluence or MCP access — the backend selects context.
Strict typed interfaces, explicit configuration, logging without sensitive bodies, input validation,
bounded requests and timeouts, no user-provided URL fetching (SSRF; network integrations use configured
allowlisted hosts), filesystem access only inside the
configured knowledge root (validate traversal and symlinks). Do not bypass authentication, RBAC, approvals
or branch protection.

## 8. Git workflow
Feature branch per milestone; atomic commits with a clear message; never force-push, never merge into
`main` and never push without an explicit request.

## 9. Acceptance and reporting
Definition of done per milestone: implemented, tested (unit + integration + E2E where UI changed),
measured (`make knowledge-eval`, before/after on the same cases), documented; `make up` still works offline
with synthetic fixtures and no external services. After each milestone report: files changed, implemented
behaviour, commands executed, test results, remaining blockers, next small step. Keep implementing rather
than only describing what to do.
Developer skills for recurring tasks live in `.claude/skills/` (knowledge authoring, sync, templates,
retrieval evaluation, external knowledge, graph exploration).
