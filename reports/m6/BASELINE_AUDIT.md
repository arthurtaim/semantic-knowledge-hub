# M6 — Step 0 baseline audit (24.11.2026)

Audit of the local checkout before any M6 code, per `.tasks/m6/07_EXECUTION_PLAN.md` §4 «Audit checkpoint» and
`08_BASELINE_AND_REUSE.md` §5. Facts below come from commands run in this checkout and from reading the code; nothing
is inferred from file names. Claims about deployed environments (Hetzner, Timeweb) are **not verified** here.

## 1. Repository state

| Item | Value |
|---|---|
| Worktree | `semantic-knowledge-hub-m6` (separate git worktree; the main checkout is on `feature/chat-history`, untouched) |
| Branch | `feature/m6-native-work-management`, created from local `main` |
| HEAD at start | `77c753a3ad14d91466a47f3e38157ee6dbc525cf` «Merge integration/stand: assistant answer quality and Template Studio» |
| `origin/main` | `77c753a3ad14d91466a47f3e38157ee6dbc525cf` |
| Diff vs GitHub baseline `77c753a` | **none** (`git diff 77c753a --stat` empty) |
| `git status` at start | clean except untracked `.tasks/` (task package, now git-ignored) and the `.venv` symlink (never committed) |
| Other branches | `main`, `feature/chat-history` (another agent), `origin/main` |

## 2. What the baseline already has (re-used, not rebuilt)

- **M5.7 model-driven tools**: `backend/app/services/assistant_loop.py` (`ToolLoop`, `ToolLoopLimits`: rounds 4,
  calls/round 4, calls total 10, tool timeout 10 s, budget 300 s), `services/assistant_tools.py`
  (`SystemToolExecutor`), `domain/assistant_tools.py` (`READ_TOOLS = catalog_query, knowledge_search, graph_inspect,
  templates_inspect`; `drafts_propose` is offered only with `create_proposal`), `adapters/ai/tool_protocol.py`. The
  loop is attached in `container.build_container` only when `AI_TOOLS_ENABLED` and the runtime instructions are not
  the fallback. → Step 5 extends this allowlist with a read-only `work_inspect`; no second runtime.
- **Template Studio**: `api/template_studio.py` (9 routes under `/api/templates/studio…`), `services/template_studio.py`,
  `domain/template_studio.py`, `frontend/src/pages/TemplateEditorPage.tsx`; four actions `view_templates`,
  `create_template`, `edit_template`, `activate_template`. **Out of M6 scope**, untouched.
- **Knowledge / Graph / Links**: `services/knowledge.py`, `graph.py`, `links.py`, `api/knowledge.py`, `api/graph.py`,
  `api/links.py` (reader's snapshot = access boundary). → Step 4 builds task↔document links on these.
- **Routes at baseline**: 83 decorated routes in `backend/app/api/*`; every `/api/*` route except `/api/health`
  declares exactly one `Action` via `require()` (enforced by `tests/test_authz.py`).

## 3. What the baseline does NOT have

- No projects, tasks, Kanban, Gantt, dependencies, scheduler, task audit or task↔document relations.
- `backend/app/adapters/tasks/base.py`: `TaskSystemAdapter` (Protocol: `enabled`, `status()`) and
  `DisabledTaskSystem` (state `disabled`, «система задач команды ещё не согласована»). `Container.tasks =
  DisabledTaskSystem()`; used only by `IntegrationService.status()` for the `task_system` row of
  `GET /api/integrations/status`. `Settings.task_system: Literal["disabled"]`.
- No React route for projects/Gantt (`frontend/src/App.tsx` routes: documents, graph, templates, ask, proposals,
  publications, integrations, corporate).

## 4. Identity and authorization (facts from code)

- `backend/app/authz.py`: `Action` (14 actions), `AuthorizationPolicy` protocol, `LocalDemoPolicy.allows(user, action)
  = user.is_demo` (any action for the demo user), `DenyAllPolicy` (always false), `require(action)` dependency.
- `backend/app/api/deps.py:get_user`: with `AUTH_MODE=local_demo` returns `Container.demo_user()` =
  `UserContext(user_id="local-demo-user", display_name="Демо-пользователь (localhost)", roles=[reader, editor],
  is_demo=True)`; any other mode → `401 unauthenticated`. There is **no** identity provider, no session, no SSO.
- `container.build_policy`: `LocalDemoPolicy` only for `local_demo`, else `DenyAllPolicy`.
- `config.security_violations` (fail closed at start): `local_demo` refused with `APP_ENV=staging|production`, with a
  non-loopback `APP_HOST`/published host, non-loopback `ALLOWED_HOSTS`/`CORS_ORIGINS`/`APP_PUBLIC_URL`;
  `AUTH_MODE=sso` always refused («not implemented»).
- **Public link of the personal test stack** (`docker-compose.claude-public.yml` + `deploy/claude-test/Caddyfile*`):
  Caddy forwards to the frontend with `header_up Host 127.0.0.1`, so the backend's host guard and start-up checks
  see a loopback request. Consequence: the backend **cannot tell** a public request from a local one; every
  visitor of the open link (or of the Basic Auth variant — one shared password) acts as the single demo operator.
  This is the reason M6 adds an explicit exposure signal (see `docs/WORK_MANAGEMENT.md` «Идентичность и права»).
- Middleware: `CsrfGuardMiddleware` (unsafe methods need `X-SKH-Client`), `HostGuardMiddleware`,
  `RequestContextMiddleware` (request id). CORS `allow_methods` lacked `PATCH` (M6 adds it; CORS is only active with
  configured loopback origins).

## 5. Persistence and migration patterns

- Plain `sqlite3`, no ORM. Stores: `ProposalStore`, `AiProposalStore`, `TemplateRegistry`, `DiscoveryStore`,
  `AttachmentStore` in `workspace/app_state.sqlite3`; `PublicationStore` in `workspace/publications.sqlite3`;
  FTS index in `workspace/search.sqlite3`.
- Each store: one long-lived connection (`check_same_thread=False`) + `threading.Lock`; schema by
  `CREATE TABLE IF NOT EXISTS`; migrations are additive `ALTER TABLE … ADD COLUMN` after `PRAGMA table_info`.
  **No** `user_version`, no migration history, no backup before migrating, `foreign_keys` not enabled.
- Decision for M6 (justified in `docs/WORK_MANAGEMENT.md` «Хранение»): a separate `workspace/work.sqlite3` with a
  versioned migration runner (`PRAGMA user_version` + `work_schema_migrations` with checksums), FK on, WAL, backup
  before migrating an existing file, one connection per unit of work. Same stack (stdlib `sqlite3`), no new
  dependency.

## 6. Test commands and baselines (run in this worktree before any change)

| Command | Result |
|---|---|
| `cd backend && ../.venv/bin/python -m ruff check app claude_worker tests` | `All checks passed!` |
| `… ruff format --check app claude_worker tests` | `204 files already formatted` |
| `… mypy app claude_worker` | `Success: no issues found in 121 source files` |
| `… pytest` | `876 passed, 6 skipped in 49.75s` |
| `cd frontend && npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npx eslint .` | exit 0 |
| `npx vitest run` | `Test Files 44 passed (44)`, `Tests 559 passed (559)` |
| `python -m app.evaluation.knowledge_eval --kb ../fixtures/knowledge --cases ../fixtures/eval --label before` | cases 216, passed 207, failed 9, R@1 0.9487, R@5 0.9744, MRR 0.9647, leaks 0 |

E2E (`make e2e`, Playwright, needs a running stack) was **not run** in this stage: no UI changed. Makefile targets
present: `setup`, `check` (= `lint` + `test`), `e2e`, `e2e-gitlab`, `preflight`, `readiness`, `mock-kb-validate`,
`mock-kb-sync`, `knowledge-eval`, `knowledge-demo`, `knowledge-eval-live` (opt-in), `claude-test-*`. No `work-eval`
target yet (Step 6).

## 7. Not verified / external

- Whether Hetzner (`178.104.231.197`) runs this SHA, and how the Timeweb proxy reaches it — not checked, not touched.
- Real GitLab, real Confluence MCP, corporate SSO, GigaChat: not present as runtime capabilities in this checkout
  (mock/disabled adapters and configuration only). M6 does not depend on any of them.
