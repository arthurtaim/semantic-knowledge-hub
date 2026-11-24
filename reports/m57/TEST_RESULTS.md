# M5.7 — test results, evaluation and latency

Branch `feature/m57-ai-native-tools-final` (worktree `semantic-knowledge-hub-m57`), base `b9ebaf3` (= `main`), measured
on `7cc9f66` + this report, 2026-11-24. macOS 26.5.2, Python 3.12.15, Node 26.13.0, Playwright 1.58.2. Every number
below is from a real run in this worktree; nothing was estimated. No live model was called (opt-in only); no deploy.

## Fixtures (synthetic only)

| Fixture | What it is | Used by |
|---|---|---|
| `fixtures/knowledge` | 83 synthetic documents (`synthetic: true`): approved 73 · in_review 4 · deprecated 3 · draft 3; 13 tagged `aris` (9 of them approved), 52 mention «ARIS» in the text | stacks, E2E, eval |
| `fixtures/eval` | 200 gold cases | deterministic eval |
| `backend/tests/test_assistant_tools.py` scoped repository | 12 canonical IDs for the owner / 11 for a guest (one restricted), renames, an edit (13 observed revisions), a deleted entry, duplicate IDs, ARIS tagged vs text, `unassigned` owners, WikiLinks + a typed relation, injected instructions | backend tool and leak tests (independent oracle) |
| `backend/tests/support/scripted_model.py` | the scripted MODEL double (loopback; keywords allowed only here) | loop tests, scripted E2E, latency |

## Commands and results

### Backend (`backend/`, shared venv)

```
ruff check app claude_worker tests            → All checks passed!
ruff format --check app claude_worker tests   → 190 files already formatted
mypy app claude_worker                        → Success: no issues found in 112 source files
pytest                                         → 755 passed, 6 skipped in 66.33s (second run: 37.90s)
```

| | passed | skipped |
|---|---|---|
| base `b9ebaf3` (Stage 0) | 670 | 6 |
| end of Stage 2 (`d7fbd5b`) | 755 | 6 |
| now (`7cc9f66`) | 755 | 6 (Stage 3 added an assertion to an existing loop test, no new test) |

The 6 skips are the opt-in live tests: `tests/live/test_claude_cli_live.py` ×4 («needs SKH_LIVE_TESTS=1 and
SKH_CLAUDE_LIVE_URL») and `tests/live/test_live_readonly.py` ×2 («live tests need SKH_LIVE_TESTS=1»).

### Frontend (`frontend/`)

```
npx tsc --noEmit -p tsconfig.json   → clean
npx eslint .                        → clean
npx vitest run                      → Test Files 34 passed (34) · Tests 411 passed (411)
```

| | files | tests |
|---|---|---|
| before (this branch at `d7fbd5b`) | 33 | 391 passed |
| after | 34 | 411 passed (+18 `systemFacts.test.tsx`, +1 stream parser in `ask.test.tsx`, +1 compact panel / follow-up context in `documentAssistant.test.tsx`) |

`tokens.test.ts` (every colour a token, dark = «Как в системе», WCAG pairs) passes: the new styles use existing tokens
only. Stability: one full run out of 40 reported 1 failed test whose name was not captured; it did not reproduce in
the next 39 full runs (19 + 20 in a capturing loop: `full-suite fails=0/20`) nor in 20 focused runs of the changed
files (`fails=0/20`). Reported as an unidentified one-off, not hidden.

### E2E — ordinary suite (mock stack, `AI_PROVIDER=mock`, Confluence disabled, ports 8020/5185)

```
E2E_SKIP_GITLAB_STACK=1 E2E_BASE_URL=http://127.0.0.1:5185 npx playwright test --project=desktop --project=mobile
```

| | result |
|---|---|
| before (this branch at `d7fbd5b`, same stack) | 51 passed, 5 skipped |
| after | 51 passed, 5 skipped (same tests) |

Skipped in both (stack configuration, not failures): C-04 / C-05 and D-05 / D-06 need `E2E_DISABLED_URL` (a stack with
`AI_PROVIDER=disabled`); «M5.6 ask with both sources» needs Confluence configured. The `gitlab-mock` /
`gitlab-mock-mobile` projects were **not run** here (they use ports 8011/5175/8929–8931 of another agent); the
coordinator runs them (reference for the full suite incl. gitlab-mock: 65 passed / 1 skipped). `e2e/m57.spec.ts` is
not selected by these projects (`testIgnore`), so the ordinary suite is unchanged.

### E2E — M5.7 against the scripted-model stack

```
E2E_SKIP_GITLAB_STACK=1 E2E_SCRIPTED_URL=http://127.0.0.1:5186 npx playwright test --project=scripted --project=scripted-mobile
```

| UI → backend → double | result |
|---|---|
| 5186 → 8022 `AI_PROVIDER=claude_cli` (worker protocol, streams deltas) → 8023 | 9 passed (5.7s) |
| 5187 → 8021 `AI_PROVIDER=internal_api` (OpenAI-compatible) → 8023 | 9 passed (5.5s) |

Scenarios (every number compared with `GET /api/documents?size=1&…` `total`, independent of the tool code):

| Test | Checks |
|---|---|
| F01 | «Сколько документов в базе?» → card «83 документа» = API total; «Весь доступный вам каталог, без фильтров»; no «Источники», no «нет ответа», no raw `[F1]`; the marker С1 has a tooltip and Enter focuses the card |
| F02/F03 | «How many documents are there?» then «А сколько из них утверждено?» → the request carries `history[0].context` (filters `{}`, value 83); card = API `status=approved` total (73) |
| F03 (referent) | «Сколько документов по ARIS?» (tag 13 / text 52, the text match labelled «не системный тег») then «А сколько из них утверждено?» → API `tag=aris&status=approved` total (9), ≠ 73: the referent was kept |
| F14 | composite → a fact card (9) AND a verified team citation (marker «Источник 1» → `/documents/…`), in separate blocks |
| F17 | «Что такое RAG?» → «Общие знания, не данные SKH», no facts, no «нет ответа» |
| S07/F25 | a hallucinated `sql_query` tool → «Не удалось проверить данные системы» + «Запрос к системе отклонён», no near matches, no `{` in the answer |
| F28 | the model fails after a verified count → «Частично подтверждено», server text «Не удалось завершить ответ…», card = API total |
| F15 | «Сделай черновик…» → the existing proposal card, no second fact card, the marker focuses it; status re-read from `GET /api/ai/proposals/{id}` is `suggested` before and after opening (nothing applied without Accept) |
| @mobile | count + follow-up on Pixel 7, cards = API totals, no horizontal scroll |

Not covered in E2E: **F23 registry outage** — the outage is the backend's, the double only plays the model, so it
cannot be induced in a running stack; covered by `test_registry_timeout_or_outage_is_honest` (backend, both timeout
and `RepositoryUnavailableError`) and by the Vitest «unavailable registry is could-not-check» test.

### Deterministic evaluation (retrieval regression)

```
python -m app.evaluation.knowledge_eval --kb ../fixtures/knowledge --cases ../fixtures/eval --label after --out <scratchpad>/eval-m57-B
[after] cases=200 pass=191 fail=9 error=0 unsupported=0 R@1=0.9487 R@5=0.9744 MRR=0.9647 leaks=0
```

Identical to the base (Stage 0) and to the Stage 2 run (`eval-m57-A`, commit `9494046`): same `kb_snapshot_hash`
`53968dee67abb249`, same `cases_hash` `db88c22b4e3e03a2`, per-case pass/fail identical on all 200 cases. Retrieval code,
the dictionary and weights were not touched in M5.7; the 9 failures are the pre-existing ones.

## Latency — content-only (RAG) path vs tool path

Same corpus (83 documents), same scripted double (port 8023), over HTTP (`POST /api/assistant/ask`, non-streaming),
50 requests per cell after one warm-up, machine otherwise idle. RAG path = `internal_api` backend with
`AI_TOOLS_ENABLED=false` (port 8020); tool path = the same backend configuration with tools on (port 8021). The double
answers instantly, so this is **backend overhead + loopback HTTP to the double**, not model latency.

| Question | Path | median | p90 | model rounds | tool calls | tool time | answer |
|---|---|---|---|---|---|---|---|
| «Сколько документов в базе?» | RAG | 9.0 / 11.5 ms | 9.4 / 12.8 ms | 1 | 0 | — | an irrelevant lexical quote (DEMO-ADR-002), no number — the original defect |
| | tools | 12.7 / 14.4 ms | 13.2 / 19.9 ms | 2 | 1 | 0 ms | 83 from the registry (fact F1) |
| «Сколько утверждённых документов об ARIS и где пробелы?» | RAG | 10.8 / 11.2 ms | 11.1 / 12.5 ms | 1 | 0 | — | a lexical quote, no count |
| | tools | 17.1 / 16.7 ms | 17.6 / 17.1 ms | 2 | 2 (count + search) | 2 ms | 9 (fact) + a verified quote |
| «Что говорит документ DEMO-INT-001 о формате выгрузки?» | RAG | 10.6 / 10.6 ms | 10.9 / 10.9 ms | 1 | 0 | — | verified quote |
| | tools | 10.9 / 10.8 ms | 11.3 / 11.2 ms | 1 | 0 | — | verified quote |

(two runs, `run b / run a`; raw JSON in the scratchpad `m57-latency-final-{a,b}.json`). Backend overhead of the tool
path: +2.9 / +3.7 ms (median) for a count and +5.5 / +6.3 ms for the composite question; a content question that
needs no tool costs the same (±0.3 ms). With a real model the cost is dominated by model rounds: a count or a composite question takes **two** model
rounds where the RAG path took one; nothing here measures that (no live model). An earlier measurement taken while a
Vitest loop loaded the machine (median 19–53 ms) was discarded as unrepresentative.

## Screenshots (not committed)

`/private/tmp/claude-501/-Users-arturtaim-GitHub-semantic-knowledge-hub/0d685b51-50ad-4915-880f-571fd893dc96/scratchpad/m57-shots/`,
scripted stack (5186, `claude_cli` → double), full page, light/dark × 1440×900 (`-d`) / 390×844 (`-m`):

- before (this branch at `d7fbd5b`, no Stage 3 UI): `before-count-*`, `before-followup-*`, `before-composite-*`,
  `before-general-*` — `[F1]` as plain text, no fact card, no general-knowledge tag;
- after: `after-count-*`, `after-followup-*`, `after-composite-*`, `after-general-*`, plus `after-draft-*` (proposal
  card) and `after-failed-*` (model failure after a verified step) — 24 files.

## What was not run

- Live model checks (`make knowledge-eval-live`, `tests/live`) — opt-in, not performed.
- `gitlab-mock` / `gitlab-mock-mobile` E2E — reserved for the coordinator (port isolation).
- The `AI_PROVIDER=disabled` and Confluence-dependent E2E scenarios — the stacks used here do not configure them
  (skipped before and after alike).
