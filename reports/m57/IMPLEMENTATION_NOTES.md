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

## Stage 1 — read-only authoritative tools (commit `249b437`)

Design and full contract: `docs/AI_NATIVE_TOOLS.md`. Code: `backend/app/domain/assistant_tools.py` (strict argument
models, allowlist, model-facing descriptions), `backend/app/services/assistant_tools.py` (`SystemToolExecutor`).

| Tool | Operations | Delegates to |
|---|---|---|
| `catalog_query` | count · list · facets · get_metadata | `KnowledgeService.snapshot(user)` (reader's snapshot), `sort_documents`, FTS `search_documents` for the labelled `text` filter |
| `knowledge_search` | search · read | `RetrievalService.passages` (statuses of THIS request), sections of the reader's document |
| `graph_inspect` | links · neighbours · path | `LinkService.links` (outgoing/backlinks), `GraphService.graph` + `graph.neighbours` / `shortest_path` |
| `templates_inspect` | list · get | `TemplateHubService.catalogue` / `detail` |
| `drafts_propose` (P1) | draft_from_prompt · improve_section · check_completeness | `AiWorkflowService.propose` — proposal only, `create_proposal` required, ≤ 1 per answer |

Count semantics as implemented: distinct canonical IDs of the reader's snapshot; all statuses the reader sees unless
`status` narrows; `eligible_for_answers` = the statuses this request may cite; tag ≠ text match (both labelled);
owner `unassigned` = `owner_missing`; zero = `ok` 0, outage = `unavailable`, timeout = `timeout`, hidden = unknown =
`not_found`. Fixture oracle (independent, `tests/test_assistant_tools.py`): owner 12 / guest 11 canonical; 9 approved
(owner), 8 (guest); guest `aris` tag 3 vs ARIS text 4; ARIS + unassigned = M57-GDE-002, M57-SRC-001; FTS chunk rows
> 12; observed revisions 13 after edit + rename → canonical ≠ chunks ≠ revisions. Demo base (83 synthetic docs,
E2E smoke): 83 total, 73 approved, 13 tag `aris`, 52 ARIS text matches, 9 approved + `aris`.

Small fix: `GraphService.graph` cache key now includes the reader's snapshot version (a graph built from another
reader's snapshot is never served).

## Stage 2 — the bounded loop (commits `49531f4`, `006328b`, `fc3d27a`)

| Existing file | Change |
|---|---|
| `adapters/ai/base.py` | `ToolSpec`, `ToolExchange(Entry)`, `ToolTurnRequest`, `ToolTurnReply`, optional `ToolCallingAIProvider.tool_turn` |
| `adapters/ai/tool_protocol.py` (new) | envelope prompt, transcript builder (data delimited/escaped), strict parser, `ToolTurnVisibleText` |
| `adapters/ai/openai_compatible.py` | `supports_tools = True`, `tool_turn` over `_post_chat`; `format_passages` extracted from `build_user_message` (same output) |
| `adapters/ai/claude_cli.py` | `supports_tools = True`, `tool_turn` over `_run` with prose-only deltas; worker flags untouched |
| `adapters/ai/mock.py` | `supports_tools = False` (decision below) |
| `services/assistant_loop.py` (new) | `ToolLoop`, `ToolLoopLimits`, `LoopOutcome`, `bounded_json` |
| `services/assistant.py` | `attach_tools`, `tool_mode`, loop path in `ask`/`ask_stream`, `_finish_tools`, `_limit_response`, facts/general in `_validated_response` (existing gate unchanged without them) |
| `domain/instructions.py`, `assistant_instructions/*` | task `tools`; `TOOL_POLICY.md` v1; ROLE v2, RETRIEVAL_GROUNDING v2, CITATION_POLICY v2 now also apply to `tools` |
| `config.py`, `container.py`, `.env.example` | `AI_TOOLS_*` guardrails; loop attached unless disabled or the instructions fell back |
| `tests/test_claude_cli_provider.py` | `test_unknown_question_never_reaches_claude` pinned to `ai_tools_enabled=False` (see deviations) |

Provider protocol: `internal_api` and `claude_cli` — constrained JSON envelope (no verified safe native tool calling;
the CLI keeps all tools disabled). **Mock decision:** `supports_tools = False` — the mock has no language
understanding, and making it choose tools would require exactly the keyword intent router M5.7 forbids; it keeps
today's content-only answer. `make up` (mock) therefore still answers «Сколько документов в базе?» with lexical
quotes — natural-language system questions need a model (or the catalog page).

Guardrail defaults: 4 rounds (last one tool-less), 4 calls/round, 10 calls/answer, 10 s per read call, provider draft
timeout for `drafts_propose`, 300 s budget, 4000 chars per result, 24000 chars of results per answer, 1 repair,
1 proposal, identical calls → `duplicate_call`.

Observed latency (E2E smoke, scripted model = zero model time, demo base, local machine): count question 11–23 ms
end to end with 2 model rounds; composite (count + search) 19 ms; content question 9 ms; tool execution 0–2 ms.
With a real model the cost is dominated by model rounds: a count takes 2 rounds where the old path took 1.

## Response contract for Stages 3–4 (UI)

`AskResponse` (additive): `system_facts[]`, `tool_steps[]`, `general_knowledge`, `conversation_context[]`;
request `history[i].context` = the previous response's `conversation_context`. Stream: `tool_call`, `tool_result`,
`status.round`. TypeScript: `frontend/src/api/types.ts` (`SystemFact`, `SystemFactItem`, `ToolStepInfo`,
`TurnFactContext`, `AskStreamToolCallEvent`, `AskStreamToolResultEvent`). Exact shapes: `docs/API_CONTRACTS.md` v0.5.

What the UI must do (Stage 3):
1. Render `system_facts` as cards «По данным реестра SKH …» with `value`, `label`, `effective_filters`/`definition`
   when non-empty, `items` as links (`app_path`), `truncated`; turn `[F1]` markers in `answer` into chips/links to the
   card (today they show as plain text). Keep `[n]` citations as they are.
2. Label `general_knowledge: true` («общие знания, не данные SKH»).
3. Send `history[i].context = response.conversation_context` with follow-ups (`useAssistantTurns` builds history).
4. Stream: on `status: generating` with `round > 1` reset the preliminary text; optionally show `tool_call` /
   `tool_result` as a small «проверяю каталог…» line (no debug screen).
5. `proposal` may now come from the loop: the existing proposal card applies.

## Scripted model double and E2E

`backend/tests/support/scripted_model.py` (scenario table in its docstring). Start it and a backend as in
`docs/AI_NATIVE_TOOLS.md` §Scripted model; both `internal_api` (port e.g. 8021) and `claude_cli` (8022, streaming)
were verified end to end on 2026-11-24 with the demo base (results above). For Playwright, start Vite with
`SKH_BACKEND_URL` pointing at that backend.

## Tests and evaluation (Stages 0–2)

- Backend before: `670 passed, 6 skipped`. After: see `reports/m57/TEST_RESULTS.md` (Stage 4) — at the end of Stage 2
  `755 passed, 6 skipped` (+32 tool tests, +53 loop tests).
- Frontend: `tsc --noEmit` clean; `vitest run` 391 passed (types only changed).
- Deterministic eval (mock provider; retrieval untouched): `cases=200 pass=191 R@1=0.9487 R@5=0.9744 MRR=0.9647
  leaks=0` — identical to the base.

## Deviations and open points

- `test_unknown_question_never_reaches_claude` now runs with `AI_TOOLS_ENABLED=false`: in the tool loop a question
  without passages must reach the model (a system question has no lexical passage). The invariant still holds for
  the content-only path; the tool-mode counterpart asserts the model text is still not shown without evidence.
- No live-model evaluation (opt-in only); tool choice by a real model is untested here.
- No native function calling, no fast path. No Confluence count tool (partial search only). No M6 tools.
- F09/F10/F16/F18/F24 rely on existing pipelines and were not re-implemented; F15/F16 through `drafts_propose`
  (draft_from_prompt / improve_section) — the improve path is covered by the existing M5.6.3 tests, the loop test
  covers draft_from_prompt.
