# External evidence from Confluence (adaptive RAG without import)

Team documents (GitLab / local) are the authority. Confluence Data Center pages, read through the
approved read-only MCP connector, may complete an answer, but they stay external: they are cited from a
fresh snapshot with their version and status, never imported, never approved automatically.
On personal servers only the **synthetic** corpus (`fixtures/confluence_mock/pages.yaml`, 24 pages) is used.

## When the assistant searches Confluence

Source switch on the Ask page:

| UI | Mode | Behaviour |
|---|---|---|
| «Команда» | `local_only` | never calls Confluence (and never the evidence gate) |
| «Оба» | `local_then_external` | the local-first evidence gate decides (below) |
| «Корпоративные» | external | always calls Confluence |

**Since 2026-11-26 the decision for «Оба» is the local-first evidence gate** (`docs/ADAPTIVE_RAG.md`,
`app/services/evidence_gate.py`): one small decision of the AI provider over bounded cards of the team passages
(`sufficient` → no call; `need_external` → 1–2 focused queries for the gap; `uncertain` → one probe), validated by
the server, with a visible fallback. Its trace is `AskResponse.evidence_gate`; the external triggers are
`evidence_gap`, `model_uncertain`, `decision_invalid`, `no_local_passages` (plus `explicit_request`,
`external_scope_selected`). Providers without the capability — the offline mock — and `EXTERNAL_GATE=lexical` keep
the lexical rule below; it is also the fallback of an invalid, late or failed model decision.

Local sufficiency (`LOCAL_SUFFICIENCY v2`, `app/services/evidence_gate.py::local_insufficiency`) fails with a reason:

| Reason | Meaning |
|---|---|
| `no_local_passages` | no team passage at all |
| `unmatched_entities` | an identifier / acronym of the question is in no eligible team document |
| `low_term_coverage` | more than 1/3 of the question's words are in no eligible team document |
| `no_single_local_source` | no single team DOCUMENT covers ≥ 2/3 of the question's words with the passages given to the model (sections of one document complement each other; words scattered over different documents are not an answer) |
| `specific_terms_not_covered` | the documents that do cover ≥ 2/3 all lack a **specific** word of the question — one found in at most 10 % of the eligible documents («лимит», «срок»): they are topical, they do not state what is asked |

v1 (until 2026-11-26) counted coverage per single passage (`no_single_local_passage`) and had no specific-word rule:
a description of the right flow without the asked value («какой лимит пакета?») was judged sufficient, while two
sections of the one answering document were not. A word that occurs in NO team document (df = 0) only counts towards
`low_term_coverage`: without semantic matching it cannot be told whether it is the subject the team never documented
or a paraphrase of a documented word («пауза» for «задержка») — `reports/README.md`.
The reason is in the answer's `external` block; `local_only` («Команда») never consults Confluence.

## Pipeline (`app/services/external.py`)

1. MCP search → up to 10 candidates; restricted pages are excluded by the connector's ACL. With the gate's focused
   queries: one search per query (≤ 2), results interleaved and de-duplicated, still ≤ 10 candidates in total.
2. Rank: entity matches ×2 — against the query a candidate answers best (the question's words without focused
   queries) — discovery hints from feedback (same ACL scope and the QUESTION's intent only), source order on ties. A page marked as a duplicate of an approved team document (`canonical_document_id`) is not a
   second piece of evidence.
3. Fetch ≤ 3 pages (concurrency 2, timeout 5 s each, deadline 12 s, circuit breaker after 5 failures for
   60 s) through a bounded LRU cache (100 pages, TTL 24 h) keyed by
   (instance, page, version, acl_scope, render/policy version).
4. Storage HTML → text keeping headings, list items and table rows; oversized pages are cut at a fixed
   limit with a visible marker and a warning; fragments are split by `##` headings, ≤ 6 fragments,
   ≤ 16 000 characters of external context.
5. Known prompt-injection patterns are redacted and reported.
6. Citations carry `source_kind: confluence_mcp`, `source_id confluence:<instance>:<page>:<version>`,
   `fragment_id`, `content_hash`, `external_status` (`unknown` is said out loud in the answer).
7. `external.outcome`: `found` · `no_match` · `insufficient_evidence` · `denied` · `source_unavailable`. Without a
   found fragment the answer says «во внешнем источнике не удалось подтвердить … это не значит, что их там нет» — a
   bounded search of a partial view never proves absence.

Before reuse (cache hit, query graph, feedback hint) the page is re-checked for access and version:
revoked, deleted or updated pages invalidate cache entries, traces and graph nodes.

## Discovery memory (`app/services/discovery.py`)

Stores retrieval traces and question → source links for 24 h by default; the question is kept as an HMAC
fingerprint (`discovery.key` next to the app state), not as text, unless
`DISCOVERY_STORE_QUERY_TEXT=true` (synthetic demo only). Relevance feedback (`POST /api/discovery/feedback`)
re-ranks future candidates for the same scope and intent; it never changes a status.

| API | Purpose |
|---|---|
| `POST /api/discovery/feedback` | useful / not useful for a source of an answer |
| `GET /api/discovery/stats` | traces, links by feedback, invalidated sources, retention, cache stats |
| `DELETE /api/discovery/traces/{id}` | forget one answer's trace |
| `DELETE /api/discovery` | purge memory and cache |
| `POST /api/discovery/propose` | create a DRAFT from an external page (template `external_import`, origin `external_page`) for normal review; it cannot be approved directly |

## Configuration

`EXTERNAL_CANDIDATES`, `EXTERNAL_FETCHES`, `EXTERNAL_FRAGMENTS`, `EXTERNAL_CONTEXT_CHARS`,
`EXTERNAL_CACHE_PAGES`, `EXTERNAL_CACHE_TTL_SECONDS`, `EXTERNAL_CONCURRENCY`, `EXTERNAL_TIMEOUT_SECONDS`,
`EXTERNAL_DEADLINE_SECONDS`, `EXTERNAL_BREAKER_FAILURES`, `EXTERNAL_BREAKER_RESET_SECONDS`,
`DISCOVERY_ENABLED`, `DISCOVERY_RETENTION_HOURS`, `DISCOVERY_STORE_QUERY_TEXT`, `DISCOVERY_HMAC_KEY_FILE`,
`CONFLUENCE_MOCK_PAGES_PATH`, `CONFLUENCE_MOCK_STATE_PATH` (see `app/config.py` for bounds). The evidence gate:
`EXTERNAL_GATE`, `EXTERNAL_GATE_*` (`docs/ADAPTIVE_RAG.md` §7).

## Mock scenario controls

```bash
cd backend
../.venv/bin/python -m app.tools.mock_confluence status
../.venv/bin/python -m app.tools.mock_confluence revoke 200121    # access revoked
../.venv/bin/python -m app.tools.mock_confluence update 200115    # switch to next_version
../.venv/bin/python -m app.tools.mock_confluence delete 200116
../.venv/bin/python -m app.tools.mock_confluence reset
```

Checks: `tests/test_external_rag.py`, eval cases `KX-*` in `fixtures/eval/cases_external_graph.yaml`; the gate:
`tests/test_adaptive_rag.py` (LF-01…LF-26), `tests/test_evidence_gate.py`, `tests/test_gap_protocol.py`,
`app/evaluation/gate_eval.py` on `fixtures/eval_adaptive/cases.yaml`.
