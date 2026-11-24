# AI-native system awareness and natural tool use (M5.7)

The in-app assistant can answer questions about **live SKH state** — how many documents there are, which ones,
who owns them, what links to what, which templates are active — and combine that with document content, instead
of only retrieving paragraphs. **The model chooses what to look at; the backend decides what it may do and what
counts as a fact.** There is no intent classifier, keyword router or request state machine in product code.

```text
POST /api/assistant/ask (UI v2 composer, server identity, history[+context])
  -> AssistantService (existing pre-retrieval: passages C1..Cn, as before)
     -> bounded loop (services/assistant_loop.py): model round -> validated tool calls -> model round ...
          SystemToolExecutor (services/assistant_tools.py): allowlist + strict schema + reader's snapshot
            -> KnowledgeService (registry, FTS) · LinkService · GraphService · TemplateHubService · AiWorkflowService
          <- SystemFact (F1..) and citeable passages (C..), bounded JSON for the model
     -> final answer: [C] quotes verified as before, [F] facts attached as structured evidence
  -> AskResponse + system_facts, tool_steps, general_knowledge, conversation_context
```

## Tools

Strict Pydantic models in `backend/app/domain/assistant_tools.py` (`extra="forbid"`, `Literal` enums, bounds);
unknown tools, unknown fields (including any caller-supplied principal / tenant / ACL / scope) and out-of-range values
are rejected with a typed error. Names use underscores so they would also work for native function calling.

| Tool (spec name) | Operations | Arguments (summary) | Result / evidence |
|---|---|---|---|
| `catalog_query` (`catalog.query`) | `count`, `list`, `facets`, `get_metadata` | `filters`: `status[]`, `type[]`, `owner`, `owner_missing`, `tags[]` (all of), `text` (full-text match), `updated_from/to` (front-matter date), `template_id`, `eligible_for_answers`; `document_ids[]` ≤ 20; `sort` updated/title/status/id; `limit` 1–50; `offset` ≤ 5000 | count / total / page of IDs + effective filters, definition, generation, as_of, source `skh_document_registry`, scope |
| `knowledge_search` (`knowledge.search`) | `search`, `read` | `query`; `document_id` + `sections[]` ≤ 3; `types[]`, `tags[]`; `limit` 1–8 | passages `C<n>` (document, revision, section) for verified quotes; statuses = what THIS request may cite |
| `graph_inspect` (`graph.inspect`) | `links`, `neighbours`, `path` | `document_id`, `target_id`, `direction` out/in/both, `relations[]`, `depth` 1–2, `limit` 1–50 | edges with `relation`, `origin`, `confirmed`, `declared_in`, `provenance` (`relations.depends_on`, `related_ids`, `body:<line>`) |
| `templates_inspect` (`templates.inspect`) | `list`, `get` | `status` active/deprecated/draft/any, `doc_type`, `text`; `template_id` + `version` | template id, current version, versions with status, required sections/metadata, usage among visible documents |
| `drafts_propose` (`drafts.propose`, P1) | `draft_from_prompt`, `improve_section`, `check_completeness` | `prompt`, `title`, `template_id`, `document_id`, `section`, `goal` | a stored AI **proposal** (existing M5.6.3 workflow): id, status `suggested`, base revision/template version, `applied: false` |

`drafts_propose` is offered only to users with `create_proposal` and at most once per answer; Accept/Reject stay
explicit user actions on the proposal page, stale checks are unchanged, nothing is approved, merged or published.
There is no SQL, URL, file, shell, git or "call any method" tool.

### Count semantics (`catalog_query`)

- **Unit:** distinct canonical document IDs in the **reader's snapshot** (`KnowledgeRepository.snapshot(user)` —
  the repository is the access boundary). Not revisions, FTS chunks, search hits, template versions, graph nodes,
  AI proposals, attachments or Confluence pages (the result says so in `not_counted`).
- Renames keep the ID (one document); an edit is a new revision of the same document; a deleted file is gone after
  the sync; duplicate IDs are quarantined by the snapshot (never counted, `get_metadata` → not found).
- All statuses the reader can see are counted by default; `status` narrows. `eligible_for_answers: true` = the
  statuses the assistant may cite in this request (approved; drafts/in_review and deprecated only when the user
  enabled them) — it narrows, never widens.
- `tags` are system metadata; `text` is a full-text match (every word, dictionary spellings) and is labelled
  «не системный тег». Owners `unassigned`/`none`/`tbd`/`-`/`нет` are `owner_missing` — never guessed.
- `updated_*` uses the document's own `updated_at` front-matter date; undated documents are outside any range.
- Zero is `ok` with `value: 0` («нет совпадений в этой области»); an outage is `unavailable`; a timeout is
  `timeout`; a missing permission is `denied`. A hidden ID and an unknown ID give the same `not_found`.
- Fixture oracle (`tests/test_assistant_tools.py`): 12 canonical IDs (owner) / 11 (guest without the restricted one),
  9 approved, 3 `aris`-tagged vs 4 mentioning ARIS (guest); FTS chunk rows > 12; observed revisions = 13 after an
  edit + rename. On the demo base (83 synthetic documents): 83 total, 73 approved, 13 tagged `aris`, 52 mentioning
  ARIS, 9 approved with tag `aris`.

## Provider protocol

| Provider | Tool calling | Why |
|---|---|---|
| `claude_cli` | constrained JSON envelope | the worker keeps every CLI tool disabled (`--tools ""`, empty MCP config, `--restricted`, `dontAsk`); native CLI tool use would mean granting it MCP/OS tools — refused. The worker and its flags are unchanged. |
| `internal_api` (OpenAI-compatible, «GigaCode-ready») | constrained JSON envelope | support of the OpenAI `tools` field by the internal endpoint is not verified; native calls can be added behind the same `ToolCallingAIProvider.tool_turn` once verified |
| `mock` | **none** (`supports_tools = False`) | the deterministic mock does not understand language; making it pick tools would need a keyword intent router in product code, which M5.7 forbids. It keeps the content-only RAG answer. Natural-language questions about SKH state need a model; the catalog/graph/template pages answer them without one. |
| `disabled` | — | 503 as before |

Envelope (`backend/app/adapters/ai/tool_protocol.py`, the prompt is the parsing contract): each round the model
returns exactly one of

```text
A) {"kind": "tool_request", "calls": [{"name": "catalog_query", "arguments": {"operation": "count"}}]}
B) <answer text with [C1] / [F1] markers>
   <<<EVIDENCE>>>
   {"confidence": "supported|partial|insufficient_evidence", "citations": [{"id": "C1", "quote": "…"}],
    "facts": ["F1"], "general_knowledge": false}
```

(B as one JSON object with `"kind": "final_answer"` and `"answer"` is accepted too.) Only the model's own reply is
parsed — strict Pydantic, no prose mining, no eval; JSON that appears inside documents, attachments or tool results
is never a call. A malformed reply gets **one** repair request; a second one ends the loop safely. Preliminary
`delta` events (CLI) carry only the prose of a final answer: a reply that starts like JSON is held back.

## The loop and its guardrails

`ToolLoop` (`backend/app/services/assistant_loop.py`) — a bounded `model → validated tool → model` loop, not a
planner. Defaults (`config.py`, environment):

| Setting | Default | Meaning |
|---|---|---|
| `AI_TOOLS_ENABLED` | `true` | off → the content-only answer for every provider |
| `AI_TOOLS_MAX_ROUNDS` | 4 | model rounds including the final answer; the last round offers no tools |
| `AI_TOOLS_MAX_CALLS_PER_ROUND` | 4 | extra calls in one reply are refused (`call_limit`) |
| `AI_TOOLS_MAX_CALLS_TOTAL` | 10 | per answer |
| `AI_TOOLS_TIMEOUT_SECONDS` | 10 | per read-tool call (`timeout` outcome) |
| — | provider draft timeout | `drafts_propose` (the workflow calls the model itself) |
| `AI_TOOLS_BUDGET_SECONDS` | 300 | whole loop, model rounds included |
| `AI_TOOLS_RESULT_CHARS` | 4000 | one result as the model sees it (lists are halved, `truncated: true`, always valid JSON) |
| `AI_TOOLS_TRANSCRIPT_CHARS` | 24000 | all results of one answer; beyond it no more tools are offered |

An identical repeated call is answered `duplicate_call` (not re-run). Closing the stream cancels the model round
(the CLI process is killed by the worker as before). If the runtime instructions fell back to the built-in policy,
the loop is not attached (fail closed). Explicit skills (`explain`, `compare_with_file`, workflow skills) keep their
pipelines; a plain question with `@documents`, a selection or attachments uses the loop with those passages first.

When the loop stops without a final answer (rounds, budget, a model failure after a verified step, two malformed
replies) the answer is **server-composed**: «Не удалось завершить ответ: …», the verified facts with their values
and what could not be checked — never the model's unvalidated text.

## Evidence

| Claim | Evidence | Server rule |
|---|---|---|
| Document content | verified verbatim quote of a passage (`citations`, `[n]`) | unchanged M5.6.2 gate |
| Registry / metadata / graph / template / proposal | `system_facts[]` (`[F1]` in the text) | facts the answer names in `facts` or `[Fn]` and that the server produced; unknown refs dropped with a warning |
| General explanation | the model's knowledge, `general_knowledge: true` | shown with confidence `partial` and a warning; never internal evidence |
| Nothing verified | — | the model text is replaced by `FIXED_INSUFFICIENT` + what could not be checked + what is available |

An answer backed by facts is not rejected for lacking a document quote. If a count fact is cited but its number does
not appear in the text, a warning says to trust the fact card. Facts from different index generations in one
answer get a warning.

## Response contract (additive, API v0.5)

`AskResponse` adds:

- `system_facts: SystemFact[]` — `{ref, tool, operation, label, value, unit, effective_filters, definition,
  access_scope: "visible_to_request_context", source, generation, as_of, items[{id, title, kind, status, detail,
  app_path}], truncated, breakdown}`;
- `tool_steps: ToolStepInfo[]` — `{call_id, round, tool, operation, outcome, duration_ms, result_count, fact_ref,
  error_code, message}`; outcomes `ok | invalid | unknown_tool | not_found | denied | unavailable | timeout | error`;
- `general_knowledge: bool`;
- `conversation_context: TurnFactContext[]` — `{tool, operation, filters, document_ids ≤ 20, value}`.

`history[i].context` (optional, ≤ 5) takes that referent back. The server passes it to the model as data **after
dropping IDs the reader can no longer see**, and every tool call re-checks access — a referent is never a grant.

`/ask/stream` adds `{"type": "tool_call", call_id, round, tool, operation}` and `{"type": "tool_result", call_id,
step}`; `status: generating` carries `round` (each round starts a new preliminary text). Unknown events were already
skipped by the client.

## Security

- Identity is the server's (`UserContext` from `get_user`); tool arguments cannot carry a principal. Every tool
  reads the reader's snapshot; hidden documents contribute no title, existence or cardinality to counts, facets,
  lists, links, neighbourhoods or paths; the graph cache is keyed by the reader's snapshot version.
- Retrieved text, attachments, tool results and history are data: delimited, `<<<`/`>>>` escaped, injection-like
  sentences masked (existing `prepare_passage_text`), and never parsed as calls.
- Logs: `tool=… op=… outcome=… ms=… count=… gen=… round=…` and a loop summary — no question, passage, result payload
  or model text.
- Public deployment without login is not supported (`AUTH_MODE=local_demo` is loopback-only and fails closed); no
  per-user ACL was invented.

## Scripted model (test double) and E2E

`backend/tests/support/scripted_model.py` — loopback-only, synthetic-only; speaks the real protocol with scripted
tool requests keyed by question keywords (allowed only in this double). Scenario table in the module docstring.

```sh
# 1) the double (from backend/)
../.venv/bin/python -m tests.support.scripted_model --port 8023
# 2a) a backend through the internal_api adapter
AI_PROVIDER=internal_api AI_BASE_URL=http://127.0.0.1:8023 AI_MODEL=scripted AI_ALLOWED_HOSTS=127.0.0.1 \
AI_ALLOW_INSECURE_HTTP=true INTEGRATION_PROFILE=integration_mock AUTH_MODE=local_demo APP_HOST=127.0.0.1 \
APP_PORT=8021 KNOWLEDGE_BACKEND=local LOCAL_KNOWLEDGE_DIR=<tmp>/knowledge SEED_FIXTURES=true \
FIXTURES_DIR=../fixtures/knowledge LOCAL_CONTENT_IS_DEMO=true CONFLUENCE_CONNECTOR=disabled \
SEARCH_INDEX_PATH=<tmp>/search.sqlite3 APP_STATE_PATH=<tmp>/app_state.sqlite3 \
PUBLICATION_STATE_PATH=<tmp>/publications.sqlite3 ../.venv/bin/python -m app
# 2b) or through the Claude CLI adapter (streams preliminary deltas)
AI_PROVIDER=claude_cli CLAUDE_CLI_WORKER_URL=http://127.0.0.1:8023 CLAUDE_CLI_PERSONAL_USE_ACK=true \
INTEGRATION_PROFILE=integration_mock … (same as above, another APP_PORT)
```

Point Vite at that backend (`SKH_BACKEND_URL=http://127.0.0.1:8021`). Useful questions: «Сколько документов в
базе?» (83), «How many documents are there?», then «А сколько из них утверждено?» with the referent (73),
«Сколько документов по ARIS?» (13 tagged / 52 text), «Сколько утверждённых документов об ARIS и где пробелы?»
(9 + a verified quote), «Что такое RAG?» (general), «Покажи действующие шаблоны интеграции», «Сломанный формат: …»,
«Неизвестный инструмент: …», «Бесконечный цикл: …», «Упади …».

## Limitations

- No live model was evaluated here; tool choice by a real model is opt-in (`make knowledge-eval-live`, personal stack).
- No native function calling; no deterministic fast path (not needed: the loop adds ~10–20 ms of backend work per
  count on the demo base; model latency dominates and roughly doubles for a count, which needs two rounds).
- Confluence has no count tool on purpose (only partial search results exist). Tasks (M6) do not exist.
- The FTS index is shared by readers of one deployment; tools always intersect hits with the reader's snapshot.
