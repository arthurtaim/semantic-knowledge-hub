# Knowledge evaluation: baseline vs after (M5.6.2)

Same 160 gold cases (`fixtures/eval`, hash `8aa66ceea17f822d`) on the same synthetic base (`fixtures/knowledge`, hash `c8698dfd83fb3741`, 83 documents), deterministic mock AI, no network.

| | baseline | after |
|---|---|---|
| code | `57e1818`: first M5.6.2 commit (new schema, KB and harness); retrieval, sync, graph and external RAG still as in M5.5 | `1730358` (untracked files only: reports, task package) |
| run at | 2026-11-23T12:51:23+00:00 | 2026-11-23T13:07:09+00:00 |
| provider | mock (deterministic, no LLM) | mock (deterministic, no LLM) |

Reproduce: `make knowledge-eval` (after). Baseline: the same harness and cases in a git worktree at `57e1818`; the current `knowledge_eval.py`/`scenarios.py` are copied in, so the same cases are scored by the same rules.

## Overall

| Metric | baseline | after | Δ |
|---|---|---|---|
| passed | 46 | 151 | +105 |
| failed | 47 | 9 | -38 |
| errors | 21 | 0 | -21 |
| unsupported (feature absent) | 46 | 0 | -46 |
| pass rate | 0.2875 | 0.9437 | +0.6562 |
| Recall@1 (search cases) | 0.4429 | 0.9487 | +0.5058 |
| Recall@5 | 0.7000 | 0.9744 | +0.2744 |
| MRR | 0.5571 | 0.9647 | +0.4076 |
| leaks (draft/deprecated/restricted) | 0 | 0 | +0 |
| context_ok (assistant) | 0.5526 | 0.8684 | +0.3158 |

The baseline Recall and MRR cover only the search cases that ran. Of the baseline errors, most are `fts5: syntax error near "("`, an M5.5 query-builder bug fixed in this milestone. The lifecycle scenarios error with `KeyError: 'last_sync'` / `'edges'` / `'version'`: M5.5 had no structured sync result, no graph API and no template versions. The lifecycle fixtures (`fixtures/knowledge_updates`) were copied into the baseline worktree, so these failures are missing features, not missing files. 46 cases are `unsupported` (graph, external RAG, discovery).

## Latency (like for like)

The per-case latencies in `after.json` are not comparable across runs. Scenario cases start their own app instance (≈0.5 s each), the eval re-scans the knowledge root on every request (`repository_refresh_seconds=0`), and baseline errors return early. The comparison below uses the same 39 search-case queries × 5 rounds on the same KB, in-process with the default refresh interval (2 s), run one after the other on the same laptop (`bench_search.py`).

| | baseline p50 / p95, ms | after p50 / p95, ms | p95 Δ |
|---|---|---|---|
| `GET /api/search` | 14.9 / 41.2 | 14.83 / 33.47 | -19 % |
| catalog `GET /api/documents?query=` | 21.82 / 43.73 | 22.79 / 48.28 | +10 % |
| index sync, no change | 274.77 | 270.41 | -2 % |
| index sync, full rebuild | 427.25 | 451.38 | +6 % |

All are within the 25 % p95 budget. The new pipeline first measured search p95 at +48 % on a loaded machine. Commit `845e2d8` brought it below the baseline: it fetches snippets only for displayed hits, caches tokens per revision and takes one snapshot per request.

## Tuning set vs holdout

Holdout cases were never used to tune the dictionary, weights or rules.

| Scope | cases | baseline pass | after pass | baseline R@1 / R@5 / MRR | after R@1 / R@5 / MRR |
|---|---|---|---|---|---|
| tuning_set | 128 | 40 | 122 | 0.4615 / 0.7692 / 0.5769 | 1.0000 / 1.0000 / 1.0000 |
| holdout | 32 | 6 | 29 | 0.3889 / 0.5000 / 0.5000 | 0.8182 / 0.9091 / 0.8750 |

## By category

| Category | cases | baseline pass (unsupported) | after pass | after R@1 | after context_ok |
|---|---|---|---|---|---|
| abbreviation | 9 | 4 (0) | 9 | 1.0000 | — |
| discovery | 8 | 0 (7) | 8 | — | — |
| exact_id | 14 | 7 (0) | 14 | 1.0000 | — |
| external_cache | 10 | 1 (6) | 10 | — | 1.0000 |
| external_rag | 12 | 1 (0) | 11 | — | 0.9167 |
| graph | 12 | 0 (12) | 12 | — | — |
| metadata_filter | 14 | 14 (0) | 14 | — | — |
| no_answer | 3 | 0 (0) | 3 | — | — |
| relation | 18 | 0 (17) | 18 | 0 | — |
| resource | 8 | 3 (4) | 8 | — | 1.0000 |
| status | 10 | 8 (0) | 9 | 1.0000 | 1.0000 |
| sync | 10 | 0 (0) | 10 | — | — |
| synonym | 14 | 5 (0) | 13 | 0.9286 | — |
| synthesis | 10 | 3 (0) | 4 | — | 0.6000 |
| template | 8 | 0 (0) | 8 | — | — |

`relation` R@1 0 comes from its only search case, KE-INTA-011. The expected document there is a typed neighbour; it is found through graph expansion at rank 2, after the direct hit, as intended, and the case passes at k = 3. The other 17 relation cases are graph-path or neighbour checks with no rank.

## Changes per case

- fixed (fail/error/unsupported → pass): **106**
- regressed (pass → fail): **1**: KE-SEM-012
- failing in both: **8**: KE-ADR-005, KE-INTA-012, KE-SEM-011, KE-SRC-004, KE-SRC-012, KE-SRC-013, KE-ST-006, KX-RAG-04

## Remaining failures (after) and why

| Case | Category | Holdout | Detail |
|---|---|---|---|
| `KE-ADR-005` | synthesis | no | facts missing from the grounded answer: ['Черновик (draft) никогда не авторитетен'] |
| `KE-INTA-012` | synthesis | no | not cited: ['DEMO-INT-002'] (cited ['DEMO-INT-001', 'DEMO-SRC-002', 'DEMO-INT-001', 'DEMO-SEM-002'], confidence partial) |
| `KE-SEM-011` | synthesis | no | facts missing from the grounded answer: ['mapping_state = retired'] |
| `KE-SEM-012` | synthesis | yes | facts missing from the grounded answer: ['ROLE-014', 'E-MAP-001'] |
| `KE-SRC-004` | synonym | yes | expected ['DEMO-SRC-008'] within top 3, got ['DEMO-SEM-003', 'DEMO-PROC-008', 'DEMO-GUIDE-001'] |
| `KE-SRC-012` | synthesis | no | not cited: ['DEMO-SRC-004'] (cited ['DEMO-INT-006', 'DEMO-INT-006', 'DEMO-SRC-006'], confidence partial); facts missing from the grounded answer: ['mdm_golden_id', 'mdm_match_score'] |
| `KE-SRC-013` | synthesis | no | facts missing from the grounded answer: ['DQ-COMP-001', '95 %', '24 ч'] |
| `KE-ST-006` | status | no | not cited: ['DEMO-SEM-012'] (cited ['DEMO-SEM-003', 'DEMO-SEM-008', 'DEMO-SEM-008', 'DEMO-SEM-001'], confidence supported) |
| `KX-RAG-04` | external_rag | yes | not cited: ['200104'] (cited ['DEMO-SRC-007', 'DEMO-PROC-003', 'DEMO-INT-004', 'DEMO-INT-001'], confidence partial); facts missing from the grounded answer: ['internal'] |

Analysis:
- **synthesis (4/10)**: answers that need several documents. Retrieval finds the right documents: context_ok
  is 0.6 for this category and 0.87 overall. But the deterministic mock generator quotes only a few passages
  verbatim, so a fact in a third document or a lower-ranked passage goes missing. This measures the offline
  mock, not an LLM; `live.json` measures the real generator on the same retrieval.
- **KE-SEM-012 (holdout, regression)**: both facts (ROLE-014, E-MAP-001) sit in one section of DEMO-SEM-006,
  and that document is in the context in both runs. Now DEMO-GUIDE-005 (the mapping guide) ranks above
  DEMO-SEM-009 and takes a passage slot, so that section of DEMO-SEM-006 no longer fits the 6-passage budget
  (context_ok false). It is a holdout case, so nothing was tuned for it. A larger passage budget was tried
  earlier and did not raise context coverage overall.
- **KX-RAG-04 (holdout)**: local documents match part of the question, so the sufficiency rule treats local
  evidence as enough and external page 200104 is never fetched. Not tuned (holdout).
- **KE-SRC-004 (holdout, synonym)**: a colloquial synonym missing from the dictionary. Adding it would mean
  tuning on the holdout, so it stays a reported miss.
- **KE-ST-006**: the in_review document is correctly excluded by status, but the case expects it to be cited
  (that needs `include_drafts`). The mock cites approved neighbours instead.

## Live generator (opt-in, Claude Code CLI on the personal test stack)

`SKH_LIVE_EVAL=1 make knowledge-eval-live` against the deployed Hetzner stack (2026-11-23T13:13:53+00:00): provider `claude_cli`, CLI 2.1.318, runtime instructions `instr-425e9f3bfa`, same retrieval, synthetic questions only, one independent request per case. The deterministic run above stays the acceptance basis.

| | cases | passed | p50 | p95 |
|---|---|---|---|---|
| live (Claude) | 33 | 26 | 3859 ms | 6069 ms |
| same cases, mock | 33 | 25 | — | — |

| Category | live passed / cases |
|---|---|
| external_rag | 10 / 12 |
| no_answer | 3 / 3 |
| status | 8 / 8 |
| synthesis | 5 / 10 |

Passed live but not with the mock: KE-ADR-005, KE-SRC-013, KE-ST-006. Passed with the mock but not live: KE-PROC-010, KX-RAG-03.

Live failures: KX-RAG-03 had the right fact and page (200103) but also cited the incomplete FAQ page 200111, which the case forbids. KX-RAG-04 (holdout) answered «недостаточно данных», because external evidence is not fetched (the same retrieval gap as with the mock). KE-INTA-012, KE-PROC-010, KE-SEM-011, KE-SEM-012 and KE-SRC-012 are multi-document synthesis cases where a required value or a second expected document is missing from the answer. No live answer cited an unverifiable source; the server drops those.

## M5.6.3 addendum (same deterministic harness)

Run `935eeb6`, 2026-11-23T14:18:15+00:00: **200 cases, 191 passed** (original 160: 151 passed — unchanged; R@1 0.9487, R@5 0.9744, MRR 0.9647, leaks 0).

| Category | cases | passed |
|---|---|---|
| metadata | 10 | 10 |
| wikilink | 10 | 10 |
| ai_workflow | 10 | 10 |
| template_hub | 10 | 10 |

Latency after M5.6.3 (same bench, measured alternately with `a7caf04` on the same laptop): search p95 29.96 ms, catalog p95 45.07 ms, sync no-op 290.66 ms, rebuild 445.75 ms (M5.6.2: 30.0–30.5 / 44.6–45.0 / 289–358 / 439–530 ms).

Hetzner CX23 (container loopback, no model): search p50/p95 23.6/79.5 ms, document_links p50/p95 3.6/4.1 ms, link_suggest p50/p95 2.7/4.4 ms, graph_overview p50/p95 6.8/38.2 ms; graph overview 97 nodes / 326 edges.

Live Claude CLI on the deployed stack (`live_m563.json`): draft_from_prompt 201 15693 ms; accept_draft 200 70 ms; improve_section 201 4325 ms; summarize 201 4531 ms; suggest_metadata 201 4977 ms; reject rejected; explain 201 4270 ms; explain_relation 201 37 ms.
