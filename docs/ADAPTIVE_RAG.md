# Local-first adaptive RAG for a weak target model

Status: implemented on `feat/skh-local-first-adaptive-rag` (2026-11-26). Release gate for the corporate target model:
**`TARGET_MODEL_NOT_VALIDATED`** — the decision step was validated with deterministic scripted doubles only.
Measurements: `reports/adaptive-rag/`.

## 1. What it does

For the source scope «Оба» (`sources = [team, corporate]`) the assistant:

1. **Searches the team knowledge base first** (unchanged retrieval: FTS5, statuses, the reader's snapshot).
2. **Asks one narrow question about MEANING:** do these authorized excerpts state everything the question asks?
   One small chat-completion call of the configured model, one compact JSON reply.
3. **Searches Confluence only for the gap**, with one or two short focused queries (not the user's prompt).
4. **Merges the evidence** with provenance, statuses and versions kept apart; the external page never overrides an
   approved team document.
5. **Answers from verified evidence only** (the existing citation gate), saying what stays unconfirmed.

```text
question + scope (+ previous question)
  → authorized team retrieval (unchanged)            sources=[team]      → never Confluence, no gap call
  → evidence cards E1…E5 (≤ 600 chars each, ≤ 3 500)  sources=[corporate] → Confluence, no gap call
  → ONE gap decision (+ ≤ 1 repair if not JSON)       search_external     → Confluence, no gap call
      sufficient     → answer from SKH, 0 MCP calls
      need_external  → ≤ 2 focused queries → bounded MCP search/fetch → answer with both sources
      uncertain      → one bounded probe; never «sufficient»
      invalid/timeout/error → documented fallback (§5), visible in the trace
  → server citation validation → AskResponse (+ evidence_gate, external.outcome)
```

This is deterministic orchestration around ONE model judgement, not an agent and not a keyword router: there is no
`if` on words of the question anywhere in the product code. The model judges meaning («пауза» is the documented
«задержка»; a flow description without the asked limit is not an answer); the server owns everything else.

## 2. Decision (ADR)

**Context.** The production model will be much weaker than Claude Opus: plain chat completion, unreliable with long
instructions, multi-step tool calling and complex JSON. Confluence is far larger and noisier than SKH. Until now the
decision was `LOCAL_SUFFICIENCY v2`, a lexical rule: it cannot tell a paraphrase from a missing subject (df = 0 words),
and the external search used the whole question, which a noisy wiki answers with similar pages.

**Decision.** A local-first evidence gate (`app/services/evidence_gate.py`) with one narrow model decision through
an optional provider capability `assess_evidence_gap` (`app/adapters/ai/base.py`, protocol
`app/adapters/ai/gap_protocol.py`). The capability is NOT part of the M5.7 tool loop: the decision is taken once, in
`AssistantService._prepare_events`, before any answer path (`/ask`, `/ask/stream`, the tool loop, skills built on ask).

**Alternatives rejected.**
- *Let the model call a Confluence tool inside the M5.7 loop* — depends on multi-step tool use (the weak model's worst
  skill), duplicates calls between the stream and the loop, and makes the source policy a model choice.
- *More lexical rules* (df = 0 → external, synonym lists per question) — the tuning loop on known questions the task
  forbids; cannot separate paraphrase from absence.
- *Embeddings / a vector DB / an LLM re-ranker over many pages* — not allowed without separate approval; the gate
  only needs a small decision over ≤ 5 short cards.

**Consequences.** One extra small model call for «Оба» questions that have local passages (0 for `team`, `corporate`,
forced search, no local passages, the offline mock). Provider-neutral: any chat model; the mock keeps the lexical rule
(nothing «semantic» is simulated). Rollback: `EXTERNAL_GATE=lexical`.

## 3. Who decides what

| Decision | Owner |
|---|---|
| `team` / `corporate` / `team+corporate`, `search_external` | the user's request — a hard server policy |
| which documents are evidence (status, ACL, snapshot), which Confluence pages are visible | server / connector |
| do the cards state every asked fact; what is missing; 1–2 search phrases | **the model** (one call) |
| evidence ids exist, identifiers of the question are in the cited passages, queries are safe | server |
| how many searches, fetches, fragments, characters, seconds; the rate budget | server |
| citations, statuses, conflict display, «unconfirmed» wording | server + the existing citation gate |

## 4. Model contract (`gap_protocol.py`)

System prompt: ~1 500 characters, self-contained (the long runtime policy of the answering prompt is not sent).
User message: the question (≤ 1 000 chars), the previous question as a referent (≤ 300, not evidence), the server
fact «words of the question that are in no team document», and ≤ 5 cards `<<<E1>>>` with JSON metadata
(`document_id`, `title`, `section`, `status`) and an excerpt (the units of the passage with most question words plus
the unit after each; injection-redacted, delimiters escaped).

Reply — exactly one JSON object:

```json
{"decision": "sufficient|need_external|uncertain", "known": ["≤3 × ≤160"], "missing": ["≤3 × ≤180"],
 "evidence_ids": ["E1"], "search_queries": ["≤2 × ≤140"]}
```

Parsed with Pydantic `extra=forbid`, strict types and the limits above. Tolerated without changing a fact: a code
fence or text around the object, `null` for an empty list, case-insensitive duplicate queries. Errors:
- **syntax** (not a JSON object: prose, «да/нет», a bare string) → ONE repair request with a short server note;
- **schema** (unknown key or decision, wrong type, too long, > limits, an id that is not a card of this request,
  `need_external` without `missing`/`search_queries`, `sufficient` without evidence or with `missing`) → invalid, no
  repair (a «repair» could only change what the model claimed).

Server checks after parsing:
- `sufficient` is accepted only if the cited passages contain every identifier/acronym of the question
  (`sufficient_entity_not_in_evidence` → treated as `uncertain`);
- each query: control characters and search operators removed; URL-like text (scheme, `www.`, an IPv4, a host with a
  well-known suffix, an absolute path, `?key=`) refuses the query; > 12 words or no content word refuses it; an
  identifier of the question missing from a query is prepended (an exact ID is never paraphrased away); duplicates
  collapse; at most `EXTERNAL_GATE_MAX_SEARCHES`. `need_external` with no safe query left is invalid (`unsafe_query`);
- `known` is never evidence; `missing` reaches the answering model only as DATA («проверка полноты не нашла …; не
  заполняй пробел догадкой»), never the user.

Providers: `internal_api` (`messages` + `temperature: 0`, no `tools`, no `response_format`) and `claude_cli` (the same
prompt → text run) implement it; `mock` and `disabled` do not.

## 5. Fallbacks and limits

| Situation | Behaviour (trace `evidence_gate`) |
|---|---|
| no team passage at all | one external search with a clean query of the question's own words (identifiers first, ≤ 8 words), no model call — `no_local_passages` |
| provider without the capability, or `EXTERNAL_GATE=lexical` | LOCAL_SUFFICIENCY v2 decides, as before — `policy: lexical-v2` |
| reply invalid after ≤ 1 repair, timeout (`EXTERNAL_GATE_TIMEOUT_SECONDS`), provider error | `decision: invalid`, `reason: decision_invalid`, `error` names why. Fallback `lexical` (default): the v2 rule decides visibly (`fallback: lexical:<code>`), searching with the question as before; if it does not search, the local answer is marked incomplete (warning, confidence ≤ partial). Fallback `local`: always local, marked incomplete. Sufficiency is never assumed |
| `uncertain` (or a `sufficient` without the question's identifier) | one probe: the model's first safe query or the clean query of the question |
| the rate budget per ACL scope is spent (`EXTERNAL_GATE_RATE_LIMIT` per window) | no model call, no search, a visible warning — `external_budget_exhausted` |
| Confluence slow or down | the existing deadline, timeouts and circuit breaker — `external.outcome: source_unavailable` |

Per answer: ≤ 2 model calls for the gate, ≤ 2 MCP searches, and the existing shared limits for everything else
(≤ 10 candidates, ≤ 3 fetches, ≤ 6 fragments, ≤ 16 000 external characters, one 12 s deadline).

**External outcome** (`AskResponse.external.outcome`): `found` · `no_match` (nothing visible matched) ·
`insufficient_evidence` (pages found, none states the sought terms) · `denied` (candidates no longer readable) ·
`source_unavailable`. For `no_match` / `insufficient_evidence` / `denied` the answer warns «во внешнем источнике не
удалось подтвердить … это не значит, что их там нет» — never «в Confluence этого нет».

**Focused search** (`ExternalEvidenceService.retrieve(…, queries, focus)`): one MCP search per query, results
interleaved and de-duplicated; a candidate is ranked, and a fragment kept, by the query it answers best (two aspects
of one question are two queries, each fragment needs to answer one of them). The question's own terms stay the
intent of the discovery memory. ACL, version re-checks, the cache rules, canonical de-duplication and revocation are
unchanged.

## 6. Observability and privacy

`AskResponse.evidence_gate` (additive, `EvidenceGateSummary`): `policy`, `decision`, `reason`, `external_called`,
`model_calls`, `repaired`, `error`, `fallback`, `lexical` (what v2 would say — A/B), `cards`, `evidence`, `missing`,
`queries`, `queries_rejected`, `incomplete`, `elapsed_ms`. Codes and counts only: the question, the gap text and the
queries are never in the response, the trace or the logs (`skh.evidence_gate` logs codes). `external` adds
`outcome`, `searches`, `focused`. The stream adds `status` events with `stage: retrieving` and `step: assessing |
external` (the UI shows «Проверяю, хватает ли сведений в документах команды…» / «Ищу недостающее во внешнем
источнике (Confluence)…»); `/ask` and `/ask/stream` run the same preparation, so the decision, the external calls
and the sources are the same.

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXTERNAL_GATE` | `semantic` | `semantic` — the model decision (providers with the capability); `lexical` — LOCAL_SUFFICIENCY v2 (rollback, A/B) |
| `EXTERNAL_GATE_TIMEOUT_SECONDS` | 20 | the gate's model call(s), repair included |
| `EXTERNAL_GATE_CARDS` | 5 | evidence cards (1–5) |
| `EXTERNAL_GATE_CARD_CHARS` / `EXTERNAL_GATE_CONTEXT_CHARS` | 600 / 3 500 | card and total excerpt size |
| `EXTERNAL_GATE_REPAIR` | true | one repair request after a non-JSON reply |
| `EXTERNAL_GATE_INVALID_FALLBACK` | `lexical` | `lexical` or `local` (§5) |
| `EXTERNAL_GATE_MAX_SEARCHES` | 2 | focused searches per answer (1–2) |
| `EXTERNAL_GATE_RATE_LIMIT` / `EXTERNAL_GATE_RATE_WINDOW_SECONDS` | 30 / 600 | gate-decided external searches per ACL scope and window (0 = off) |

## 8. Testing without the target model

- `tests/test_gap_protocol.py` — every malformed shape of the contract (fence, prose, `{}`, unknown key, «да/нет»,
  pseudo-confidence, E7, 10 queries, duplicates, URLs, oversized replies).
- `tests/test_evidence_gate.py` — cards, repair, fallbacks, timeouts, identifier guard, rate budget, the lexical policy.
- `tests/test_adaptive_rag.py` — the acceptance matrix LF-01…LF-26 end to end on a new synthetic mini-corpus and a
  mock Confluence corpus (incl. 120 noisy pages).
- `tests/test_gap_providers.py` — the wire contract of `internal_api` and `claude_cli`; the tool loop gets the one
  decision and never searches twice.
- `app/evaluation/gap_doubles.py` — **scripted doubles, not models**: an oracle (a perfect reader of the cards — an
  upper bound of the pipeline), a weak double (prose instead of JSON, fences, unknown keys, invented ids, premature
  «sufficient», needless «need_external», the whole question or a URL as the query), always-external and
  always-sufficient. `app/evaluation/gate_eval.py` runs them on `fixtures/eval_adaptive/cases.yaml`.

**Weak-model sign-off (required before production on the target model):** run 30–50 independent questions on the
target model (`AI_PROVIDER=internal_api`, synthetic corpus, explicit approval), record the confusion matrix, JSON
errors and repairs, needless MCP calls, p95 of the gate call and its cost, and compare with the scripted runs in
`reports/adaptive-rag/`. Until then: `TARGET_MODEL_NOT_VALIDATED`.
