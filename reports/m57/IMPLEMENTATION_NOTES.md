# M5.7 — AI-native system awareness & natural tool use: implementation notes

Branch `feature/m57-ai-native-tools-final`, worktree `semantic-knowledge-hub-m57`. Stages 0–2 (backend, provider
protocol, scripted model double). Stages 3–4 (UI v2 attribution, E2E, evaluation, final reports) follow.

## Stage 0 — inspected base

| Item | Value |
|---|---|
| Base commit | `b9ebaf3` = `origin/main` («Merge feature/ui-v2-workspace: UI v2 …») |
| M5.6.3 | `79d325d` is an ancestor of `b9ebaf3` (verified by the coordinator) |
| UI v2 | `6cc3bc2` + review round `82f4d1e` are ancestors of `b9ebaf3`; the old branch was merged and deleted |
| Integration merge | not needed — the base already contains both |
| Backend tests on the base | 670 passed, 6 skipped |
| Deterministic eval on the base | cases=200 pass=191 R@1=0.9487 R@5=0.9744 MRR=0.9647 leaks=0 |

Providers really present in the code (verified, nothing assumed):

- `mock` (`adapters/ai/mock.py`) — deterministic, offline default, extractive quotes only.
- `internal_api` (`adapters/ai/openai_compatible.py`) — allowlisted OpenAI-compatible endpoint, text JSON protocol
  (`{"answer","confidence","citations"}`), `temperature: 0`; no `tools`/`functions` field is sent anywhere.
- `claude_cli` (`adapters/ai/claude_cli.py`) — talks to the isolated worker (`backend/claude_worker`), which runs
  `claude -p --output-format stream-json` with `--tools ""`, `--restricted`, `--strict-mcp-config` + empty MCP config,
  `--permission-mode dontAsk`, an empty private cwd, and aborts the run if the CLI reports any tool/MCP server or
  starts a tool call. Text in, text out; one CLI process per request (no session persistence).
- **No GigaCode adapter exists** — only `docs/GIGACODE_MIGRATION.md` and the provider-neutral internal API adapter.
  Nothing GigaCode-specific was touched.

Neither real provider offers native tool calling in this code base: the CLI worker deliberately disables every
tool (native CLI tool use would mean granting it MCP/OS tools — refused), and the internal endpoint's support for
the OpenAI `tools` field is not verified anywhere. → the constrained JSON envelope (spec §03 option B) is used.

ACL model (verified): the **reader's snapshot** is the access boundary — `KnowledgeRepository.snapshot(user)`
returns only what the user may read (local demo: one identity with the whole workspace; GitLab: one service
identity). Leak tests use a scoped repository double that returns different snapshots per user
(`tests/test_wikilinks.py::test_inaccessible_documents_leak_nothing_through_links`,
`evaluation/scenarios_m563.py::wl_inaccessible_target_no_leak`). Confluence ACL: `UserContext.allowed_spaces`,
checked by the connector before ranking. Route permissions: `authz.Action` + `LocalDemoPolicy`.

## Stage 0 — reproduction of «Сколько документов в базе?»

Local stack (`AI_PROVIDER=mock`, `CONFLUENCE_CONNECTOR=disabled`, 83 synthetic documents seeded from
`fixtures/knowledge`). Registry truth: `GET /api/knowledge/facets` → `total 83`, statuses
`approved 73 · in_review 4 · deprecated 3 · draft 3`.

```
POST /api/assistant/ask {"question":"Сколько документов в базе?"}
answer: Демо-режим: … 1. «Поиск по базе знаний лексический (SQLite FTS5, решение SEM-DEC-001): …
confidence: supported
citations: DEMO-ADR-002, DEMO-ADR-005, DEMO-GOV-007        ← lexical snippets, no count anywhere

POST /api/assistant/ask {"question":"How many documents are there?"}
answer: Недостаточно данных: … не встречаются «many» …     ← rejected
confidence: insufficient_evidence
```

Traced path (`services/skills.py` → `services/assistant.py`):

1. `AssistantSkillService.plan/run` → default skill `ask` → `AssistantService.ask`.
2. `_prepare`: `retrieval.analyze(question)` → FTS terms («документ», «база») → `retrieval.passages(...)`
   with `statuses={approved}` → up to 6 passages that merely contain the words.
3. Provider call with those passages only. The model has no access to the registry, so a real model either
   quotes irrelevant passages or says «insufficient».
4. `_validated_response`: an answer without a verified verbatim document quote is forced to
   `insufficient_evidence` («Ответ без проверяемых цитат отклонён»), and its text is replaced.

So the defect is a capability gap (no registry access for the model) plus an evidence-type gap (only document
quotes count as evidence). The fix keeps the citation gate for document claims and adds authoritative,
structured system facts.

## Stage 0 — existing file → tiny extension

| Existing file | Extension |
|---|---|
| `adapters/ai/base.py` | optional `ToolCallingAIProvider` capability (one round of the loop: request → raw reply, optional preliminary deltas) + `ToolTurnRequest` dataclasses; `AIProvider` unchanged |
| `adapters/ai/tool_protocol.py` (new, shared) | the constrained envelope: protocol prompt, transcript builder, strict Pydantic parser (`tool_request` vs `final_answer`) |
| `adapters/ai/openai_compatible.py` / `claude_cli.py` | `supports_tools = True` + `tool_turn()` reusing `_post_chat` / `_run`; existing methods untouched |
| `adapters/ai/mock.py` | `supports_tools = False` (no keyword router in the product mock) |
| `domain/assistant_tools.py` (new) | strict argument models (`extra="forbid"`, `Literal`, bounds), tool descriptions, `SystemFact`/`ToolStepInfo` response models |
| `services/assistant_tools.py` (new) | `SystemToolExecutor`: thin adapters over `KnowledgeService` (snapshot, retrieval, FTS), `LinkService`, `GraphService`, `TemplateHubService`, `AiWorkflowService`; server identity only; bounded outputs with generation/as_of/source/filters/scope |
| `services/assistant_loop.py` (new) | bounded model → tool → model loop (rounds, calls, timeouts, budget, one repair, honest limits) |
| `services/assistant.py` | `ask`/`ask_stream` use the loop when the provider supports tools and tools are enabled; evidence finish accepts verified system facts; existing content-only path unchanged |
| `services/graph.py` | graph cache keyed by the reader's snapshot version too (no cross-reader reuse) |
| `domain/models.py` | additive `AskResponse` fields (`system_facts`, `tool_steps`, `general_knowledge`, `conversation_context`), optional `ConversationTurnIn.context` |
| `domain/instructions.py` + `assistant_instructions/TOOL_POLICY.md` | new runtime task `tools` and a versioned tool policy |
| `config.py` / `container.py` | guardrail settings (`AI_TOOLS_*`), wiring |
| `tests/support/scripted_model.py` (new) | loopback scripted model double speaking the real protocol (OpenAI-compatible and Claude-worker shapes) |
